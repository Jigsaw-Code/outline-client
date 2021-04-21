// Copyright 2021 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package org.outline.net;

import android.annotation.SuppressLint;
import android.support.annotation.Nullable;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigInteger;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Static utility class to perform HTTPs requests.
 */
public class Https {
  private static final int TIMEOUT_MS = 30 * 1000;

  public static class Request {
    public final String url;
    public final String method;
    @Nullable public final byte[] certFingerprint;

    public Request(String url, String method, @Nullable byte[] certFingerprint) {
      this.url = url;
      this.method = method;
      this.certFingerprint = certFingerprint;
    }
  }

  public static class Response {
    public final int statusCode;
    @Nullable public final String body;
    @Nullable public final String redirectUrl;

    public Response(int statusCode, @Nullable String body, @Nullable String redirectUrl) {
      this.statusCode = statusCode;
      this.body = body;
      this.redirectUrl = redirectUrl;
    }
  }

  // Pins `trustedCertSha256Hash` and validates it against the server certificate SHA256 hash.
  private static TrustManager[] getPinnedCertTrustManger(byte[] trustedCertSha256Hash) {
    return new TrustManager[] { new X509TrustManager() {
      @Override public void checkClientTrusted(X509Certificate[] chain, String authType)
        throws CertificateException{checkCertificateTrusted(chain, trustedCertSha256Hash);
      }

      @Override
      public void checkServerTrusted(X509Certificate[] chain, String authType)
        throws CertificateException {
        checkCertificateTrusted(chain, trustedCertSha256Hash);
      }

      private void checkCertificateTrusted(X509Certificate[] chain, byte[] trustedCertSha256Hash)
        throws CertificateException {
        if (chain == null || chain.length == 0) {
          throw new IllegalArgumentException("did not receive certificate");
        }
        X509Certificate cert = chain[0];
        try {
          MessageDigest digest = MessageDigest.getInstance("SHA-256");
          byte[] certSha256Hash = digest.digest(cert.getEncoded());
          if (!Arrays.equals(certSha256Hash, trustedCertSha256Hash)) {
              throw new Exception(
                  "server certificate fingerprint does not match certificate fingerprint");
          }
        } catch (Exception e) {
          throw new CertificateException(e);
        }
      }

      public X509Certificate[] getAcceptedIssuers() {
          return null;
      }
    }};
  }

  // Disable hostname verification to support self-signed certificates.
  // Outline servers' certificates maintain the hostname with which they were created.
  private static final HostnameVerifier noopHostnameVerifier = new HostnameVerifier() {
    @SuppressLint("BadHostnameVerifier")
    @Override
    public boolean verify(String hostname, SSLSession session) {
      return true;
    }
  };

  /**
   * Retrieves data from an HTTPs server.
   *
   * @param request Https.Request determines the request parameters. When `request.certFingerprint`
   *                is set, validates the server TLS certificate by comparing its
   *                fingerprint to the trusted certificate fingerprint.
   * @return Https.Response
   * @throws java.net.MalformedURLException if `request.url` is not a valid HTTPs URL.
   * @throws java.net.UnknownHostException on DNS resolution failure.
   * @throws java.net.ProtocolException if `request.method` is not a valid HTTP method.
   * @throws java.net.ConnectException if the HTTPs connection cannot be established.
   * @throws javax.net.ssl.SSLHandshakeException on TLS certificate validation errors.
   * @throws java.net.SocketTimeoutException if connecting or reading times out.
   * @throws java.io.IOException on read failure.
   */
  public static Response fetch(Request request) throws Exception {
    URL url = new URL(request.url);
    if (!"https".equals(url.getProtocol())) {
      throw new java.net.MalformedURLException("protocol must be https");
    }
    HttpsURLConnection conn = (HttpsURLConnection) url.openConnection();
    conn.setRequestMethod(request.method);
    conn.setConnectTimeout(TIMEOUT_MS);
    conn.setReadTimeout(TIMEOUT_MS);
    conn.setInstanceFollowRedirects(false);

    if (request.certFingerprint != null) {
      // Pin trusted certificate fingerprint.
      SSLContext context = SSLContext.getInstance("TLS");
      context.init(
          null, getPinnedCertTrustManger(request.certFingerprint), new java.security.SecureRandom());
      conn.setSSLSocketFactory(context.getSocketFactory());
      conn.setHostnameVerifier(noopHostnameVerifier);
    }

    int statusCode = conn.getResponseCode();
    if (statusCode >= 400) {
      return new Response(statusCode, null, null);
    } else if (statusCode >= 300) {
      return new Response(statusCode, null, conn.getHeaderField("Location"));
    }

    try (BufferedReader streamReader = new BufferedReader(
             new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
      StringBuilder responseStrBuilder = new StringBuilder();
      String inputStr;
      while ((inputStr = streamReader.readLine()) != null) {
        responseStrBuilder.append(inputStr);
      }
      return new Response(statusCode, responseStrBuilder.toString(), null);
    }
  }

  /**
   * Parses an Https.Request from a JSONObject.
   * @param jsonRequest JSONObject to parse.
   * @return Http.Request
   * @throws JSONException if `request.url` is missing or `request.hexSha256CertFingerprint` is not
   *                       a valid HEX-encoded string.
   */
  public static Request jsonObjectToRequest(JSONObject jsonRequest) throws JSONException {
    final String url = jsonRequest.getString("url"); // URL is required; throw if absent.
    String method = "GET";
    try {
      method = jsonRequest.getString("method").toUpperCase();
    } catch (JSONException e) {
      // Don't throw, method is optional.
    }
    byte[] certFingerprint = null;
    try {
      String hexSha256CertFingerprint =
          jsonRequest.getString("hexSha256CertFingerprint").replaceAll(":", "");
      certFingerprint = new BigInteger(hexSha256CertFingerprint, 16).toByteArray();
    } catch (JSONException e) {
      // Don't throw, certificate fingerprint is optional.
    }
    return new Https.Request(url, method, certFingerprint);
  }

  /**
   * Encodes an Http.Response into a JSONObject.
   * @param response Http.Response to encode.
   * @return JSONObject
   * @throws JSONException if encoding fails.
   */
  public static JSONObject responseToJsonObject(Response response) throws JSONException {
    JSONObject jsonResponse = new JSONObject();
    jsonResponse.put("statusCode", response.statusCode);
    // JSONObject does not support null values, check optionals before putting.
    if (response.body != null) {
      jsonResponse.put("body", response.body);
    }
    if (response.redirectUrl != null) {
      jsonResponse.put("redirectUrl", response.redirectUrl);
    }
    return jsonResponse;
  }
}
