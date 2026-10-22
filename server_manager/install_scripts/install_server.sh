#!/bin/bash
#
# Copyright 2018 The Outline Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Script to install the Outline Server docker container, a watchtower docker container
# (to automatically update the server), and to create a new Outline user.

# You may set the following environment variables, overriding their defaults:
# SB_IMAGE: The Outline Server Docker image to install, e.g. quay.io/outline/shadowbox:nightly
# CONTAINER_NAME: Docker instance name for shadowbox (default shadowbox).
#     For multiple instances also change SHADOWBOX_DIR to an other location
#     e.g. CONTAINER_NAME=shadowbox-inst1 SHADOWBOX_DIR=/opt/outline/inst1
# SHADOWBOX_DIR: Directory for persistent Outline Server state.
# ACCESS_CONFIG: The location of the access config text file.
# SB_DEFAULT_SERVER_NAME: Default name for this server, e.g. "Outline server New York".
#     This name will be used for the server until the admins updates the name
#     via the REST API.
# SENTRY_LOG_FILE: File for writing logs which may be reported to Sentry, in case
#     of an install error. No PII should be written to this file. Intended to be set
#     only by do_install_server.sh.
# WATCHTOWER_REFRESH_SECONDS: refresh interval in seconds to check for updates,
#     defaults to 3600.
#
# Deprecated:
# SB_PUBLIC_IP: Use the --hostname flag instead
# SB_API_PORT: Use the --api-port flag instead

# Requires curl and docker to be installed

set -euo pipefail

function display_usage() {
  cat <<EOF
Usage: install_server.sh [--hostname <hostname>] [--api-port <port>] [--keys-port <port>]

  --hostname   The hostname to be used to access the management API and access keys
  --api-port   The port number for the management API
  --keys-port  The port number for the access keys
EOF
}

readonly SENTRY_LOG_FILE=${SENTRY_LOG_FILE:-}

# I/O conventions for this script:
# - Ordinary status messages are printed to STDOUT
# - STDERR is only used in the event of a fatal error
# - Detailed logs are recorded to this FULL_LOG, which is preserved if an error occurred.
# - The most recent error is stored in LAST_ERROR, which is never preserved.
FULL_LOG="$(mktemp -t outline_logXXXXXXXXXX)"
LAST_ERROR="$(mktemp -t outline_last_errorXXXXXXXXXX)"
readonly FULL_LOG LAST_ERROR

function log_command() {
  # Direct STDOUT and STDERR to FULL_LOG, and forward STDOUT.
  # The most recent STDERR output will also be stored in LAST_ERROR.
  "$@" > >(tee -a "${FULL_LOG}") 2> >(tee -a "${FULL_LOG}" > "${LAST_ERROR}")
}

function log_error() {
  local -r ERROR_TEXT="\033[0;31m"  # red
  local -r NO_COLOR="\033[0m"
  echo -e "${ERROR_TEXT}$1${NO_COLOR}"
  echo "$1" >> "${FULL_LOG}"
}

# Pretty prints text to stdout, and also writes to sentry log file if set.
function log_start_step() {
  log_for_sentry "$@"
  local -r str="> $*"
  local -ir lineLength=47
  echo -n "${str}"
  local -ir numDots=$(( lineLength - ${#str} - 1 ))
  if (( numDots > 0 )); then
    echo -n " "
    for _ in $(seq 1 "${numDots}"); do echo -n .; done
  fi
  echo -n " "
}

# Prints $1 as the step name and runs the remainder as a command.
# STDOUT will be forwarded.  STDERR will be logged silently, and
# revealed only in the event of a fatal error.
function run_step() {
  local -r msg="$1"
  log_start_step "${msg}"
  shift 1
  if log_command "$@"; then
    echo "OK"
  else
    # Propagates the error code
    return
  fi
}

function confirm() {
  echo -n "> $1 [Y/n] "
  local RESPONSE
  read -r RESPONSE
  RESPONSE=$(echo "${RESPONSE}" | tr '[:upper:]' '[:lower:]') || return
  [[ -z "${RESPONSE}" || "${RESPONSE}" == "y" || "${RESPONSE}" == "yes" ]]
}

function command_exists {
  command -v "$@" &> /dev/null
}

function log_for_sentry() {
  if [[ -n "${SENTRY_LOG_FILE}" ]]; then
    echo "[$(date "+%Y-%m-%d@%H:%M:%S")] install_server.sh" "$@" >> "${SENTRY_LOG_FILE}"
  fi
  echo "$@" >> "${FULL_LOG}"
}

# Check to see if docker is installed.
function verify_docker_installed() {
  if command_exists docker; then
    return 0
  fi
  log_error "NOT INSTALLED"
  if ! confirm "Would you like to install Docker? This will run 'curl https://get.docker.com/ | sh'."; then
    exit 0
  fi
  if ! run_step "Installing Docker" install_docker; then
    log_error "Docker installation failed, please visit https://docs.docker.com/install for instructions."
    exit 1
  fi
  log_start_step "Verifying Docker installation"
  command_exists docker
}

function verify_docker_running() {
  local STDERR_OUTPUT
  STDERR_OUTPUT="$(docker info 2>&1 >/dev/null)"
  local -ir RET=$?
  if (( RET == 0 )); then
    return 0
  elif [[ "${STDERR_OUTPUT}" == *"Is the docker daemon running"* ]]; then
    start_docker
    return
  fi
  return "${RET}"
}

function fetch() {
  curl --silent --show-error --fail "$@"
}

function install_docker() {
  (
    # Change umask so that /usr/share/keyrings/docker-archive-keyring.gpg has the right permissions.
    # See https://github.com/OutlineFoundation/outline-server/issues/951.
    # We do this in a subprocess so the umask for the calling process is unaffected.
    umask 0022
    fetch https://get.docker.com/ | sh
  ) >&2
}

function start_docker() {
  systemctl enable --now docker.service >&2
}

function docker_container_exists() {
  docker ps -a --format '{{.Names}}' | grep --quiet "^$1$"
}

function remove_watchtower_container() {
  remove_docker_container watchtower
}

function remove_docker_container() {
  docker rm -f "$1" >&2
}

function handle_docker_container_conflict() {
  local -r CONTAINER_NAME="$1"
  local -r EXIT_ON_NEGATIVE_USER_RESPONSE="$2"
  local PROMPT="The container name \"${CONTAINER_NAME}\" is already in use by another container. This may happen when running this script multiple times."
  if [[ "${EXIT_ON_NEGATIVE_USER_RESPONSE}" == 'true' ]]; then
    PROMPT="${PROMPT} We will attempt to remove the existing container and restart it. Would you like to proceed?"
  else
    PROMPT="${PROMPT} Would you like to replace this container? If you answer no, we will proceed with the remainder of the installation."
  fi
  if ! confirm "${PROMPT}"; then
    if ${EXIT_ON_NEGATIVE_USER_RESPONSE}; then
      exit 0
    fi
    return 0
  fi
  if run_step "Removing ${CONTAINER_NAME} container" "remove_${CONTAINER_NAME}_container" ; then
    log_start_step "Restarting ${CONTAINER_NAME}"
    "start_${CONTAINER_NAME}"
    return $?
  fi
  return 1
}

# Set trap which publishes error tag only if there is an error.
function finish {
  local -ir EXIT_CODE=$?
  if (( EXIT_CODE != 0 )); then
    if [[ -s "${LAST_ERROR}" ]]; then
      log_error "\nLast error: $(< "${LAST_ERROR}")" >&2
    fi
    log_error "\nSorry! Something went wrong. If you can't figure this out, please copy and paste all this output into the Outline Manager screen, and send it to us, to see if we can help you." >&2
    log_error "Full log: ${FULL_LOG}" >&2
  else
    rm "${FULL_LOG}"
  fi
  rm "${LAST_ERROR}"
}

function get_random_port {
  local -i num=0  # Init to an invalid value, to prevent "unbound variable" errors.
  until (( 1024 <= num && num < 65536)); do
    num=$(( RANDOM + (RANDOM % 2) * 32768 ));
  done;
  echo "${num}";
}

function create_persisted_state_dir() {
  readonly STATE_DIR="${SHADOWBOX_DIR}/persisted-state"
  mkdir -p "${STATE_DIR}"
  chmod ug+rwx,g+s,o-rwx "${STATE_DIR}"
}

# Generate a secret key for access to the Management API and store it in a tag.
# 16 bytes = 128 bits of entropy should be plenty for this use.
function safe_base64() {
  # Implements URL-safe base64 of stdin, stripping trailing = chars.
  # Writes result to stdout.
  # TODO: this gives the following errors on Mac:
  #   base64: invalid option -- w
  #   tr: illegal option -- -
  local url_safe
  url_safe="$(base64 -w 0 - | tr '/+' '_-')"
  echo -n "${url_safe%%=*}"  # Strip trailing = chars
}

function generate_secret_key() {
  SB_API_PREFIX="$(head -c 16 /dev/urandom | safe_base64)"
  readonly SB_API_PREFIX
}

function generate_certificate() {
  # Generate self-signed cert and store it in the persistent state directory.
  local -r CERTIFICATE_NAME="${STATE_DIR}/shadowbox-selfsigned"
  readonly SB_CERTIFICATE_FILE="${CERTIFICATE_NAME}.crt"
  readonly SB_PRIVATE_KEY_FILE="${CERTIFICATE_NAME}.key"
  declare -a openssl_req_flags=(
    -x509 -nodes -days 36500 -newkey rsa:4096
    -subj "/CN=${PUBLIC_HOSTNAME}"
    -keyout "${SB_PRIVATE_KEY_FILE}" -out "${SB_CERTIFICATE_FILE}"
  )
  openssl req "${openssl_req_flags[@]}" >&2
}

function generate_certificate_fingerprint() {
  # Add a tag with the SHA-256 fingerprint of the certificate.
  # (Electron uses SHA-256 fingerprints: https://github.com/electron/electron/blob/9624bc140353b3771bd07c55371f6db65fd1b67e/atom/common/native_mate_converters/net_converter.cc#L60)
  # Example format: "SHA256 Fingerprint=BD:DB:C9:A4:39:5C:B3:4E:6E:CF:18:43:61:9F:07:A2:09:07:37:35:63:67"
  local CERT_OPENSSL_FINGERPRINT
  CERT_OPENSSL_FINGERPRINT="$(openssl x509 -in "${SB_CERTIFICATE_FILE}" -noout -sha256 -fingerprint)" || return
  # Example format: "BDDBC9A4395CB34E6ECF1843619F07A2090737356367"
  local CERT_HEX_FINGERPRINT
  CERT_HEX_FINGERPRINT="$(echo "${CERT_OPENSSL_FINGERPRINT#*=}" | tr -d :)" || return
  output_config "certSha256:${CERT_HEX_FINGERPRINT}"
}

function join() {
  local IFS="$1"
  shift
  echo "$*"
}

function write_config() {
  local -a config=()
  if (( FLAGS_KEYS_PORT != 0 )); then
    config+=("\"portForNewAccessKeys\": ${FLAGS_KEYS_PORT}")
  fi
  if [[ -n "${SB_DEFAULT_SERVER_NAME:-}" ]]; then
    config+=("\"name\": \"$(escape_json_string "${SB_DEFAULT_SERVER_NAME}")\"")   
  fi
  config+=("\"hostname\": \"$(escape_json_string "${PUBLIC_HOSTNAME}")\"")
  config+=("\"metricsEnabled\": ${SB_METRICS_ENABLED:-false}")
  echo "{$(join , "${config[@]}")}" > "${STATE_DIR}/shadowbox_server_config.json"
}

function start_shadowbox() {
  # TODO(fortuna): Write API_PORT to config file,
  # rather than pass in the environment.
  local -r START_SCRIPT="${STATE_DIR}/start_container.sh"
  cat <<-EOF > "${START_SCRIPT}"
# This script starts the Outline server container ("Shadowbox").
# If you need to customize how the server is run, you can edit this script, then restart with:
#
#     "${START_SCRIPT}"

set -eu

docker stop "${CONTAINER_NAME}" 2> /dev/null || true
docker rm -f "${CONTAINER_NAME}" 2> /dev/null || true

docker_command=(
  docker
  run
  -d
  --name "${CONTAINER_NAME}" --restart always --net host

  # Used by Watchtower to know which containers to monitor.
  --label 'com.centurylinklabs.watchtower.enable=true'
  
  # Use log rotation. See https://docs.docker.com/config/containers/logging/configure/.
  --log-driver local

  # The state that is persisted across restarts.
  -v "${STATE_DIR}:${STATE_DIR}"
    
  # Where the container keeps its persistent state.
  -e "SB_STATE_DIR=${STATE_DIR}"

  # Port number and path prefix used by the server manager API.
  -e "SB_API_PORT=${API_PORT}"
  -e "SB_API_PREFIX=${SB_API_PREFIX}"

  # Location of the API TLS certificate and key.
  -e "SB_CERTIFICATE_FILE=${SB_CERTIFICATE_FILE}"
  -e "SB_PRIVATE_KEY_FILE=${SB_PRIVATE_KEY_FILE}"

  # Where to report metrics to, if opted-in.
  -e "SB_METRICS_URL=${SB_METRICS_URL:-}"

  # The Outline server image to run.
  "${SB_IMAGE}"
)
"\${docker_command[@]}"
EOF
  chmod +x "${START_SCRIPT}"
  # Declare then assign. Assigning on declaration messes up the return code.
  local STDERR_OUTPUT
  STDERR_OUTPUT="$({ "${START_SCRIPT}" >/dev/null; } 2>&1)" && return
  readonly STDERR_OUTPUT
  log_error "FAILED"
  log_error "${STDERR_OUTPUT}"
  return 1
}

function start_watchtower() {
  # Start watchtower to automatically fetch docker image updates.
  # Set watchtower to refresh every 30 seconds if a custom SB_IMAGE is used (for
  # testing).  Otherwise refresh every hour.
  local -ir WATCHTOWER_REFRESH_SECONDS="${WATCHTOWER_REFRESH_SECONDS:-3600}"
  local -ar docker_watchtower_flags=(--name watchtower --log-driver local --restart always \
      -v /var/run/docker.sock:/var/run/docker.sock)
  # By itself, local messes up the return code.
  local STDERR_OUTPUT
  STDERR_OUTPUT="$(docker run -d "${docker_watchtower_flags[@]}" nickfedor/watchtower --cleanup --label-enable --tlsverify --interval "${WATCHTOWER_REFRESH_SECONDS}" 2>&1 >/dev/null)" && return
  readonly STDERR_OUTPUT
  log_error "FAILED"
  if docker_container_exists watchtower; then
    handle_docker_container_conflict watchtower false
    return
  else
    log_error "${STDERR_OUTPUT}"
    return 1
  fi
}

# Waits for the service to be up and healthy
function wait_shadowbox() {
  # We use insecure connection because our threat model doesn't include localhost port
  # interception and our certificate doesn't have localhost as a subject alternative name
  until fetch --insecure "${LOCAL_API_URL}/access-keys" >/dev/null; do sleep 1; done
}

function create_first_user() {
  fetch --insecure --request POST "${LOCAL_API_URL}/access-keys" >&2
}

function output_config() {
  echo "$@" >> "${ACCESS_CONFIG}"
}

function add_api_url_to_config() {
  output_config "apiUrl:${PUBLIC_API_URL}"
}

function check_firewall() {
  # TODO(JonathanDCohen) This is incorrect if access keys are using more than one port.
  local -i ACCESS_KEY_PORT
  ACCESS_KEY_PORT=$(fetch --insecure "${LOCAL_API_URL}/access-keys" |
      docker exec -i "${CONTAINER_NAME}" node -e '
          const fs = require("fs");
          const accessKeys = JSON.parse(fs.readFileSync(0, {encoding: "utf-8"}));
          console.log(accessKeys["accessKeys"][0]["port"]);
      ') || return
  readonly ACCESS_KEY_PORT
  if ! fetch --max-time 5 --cacert "${SB_CERTIFICATE_FILE}" "${PUBLIC_API_URL}/access-keys" >/dev/null; then
     log_error "BLOCKED"
     FIREWALL_STATUS="\
You won’t be able to access it externally, despite your server being correctly
set up, because there's a firewall (in this machine, your router or cloud
provider) that is preventing incoming connections to ports ${API_PORT} and ${ACCESS_KEY_PORT}."
  else
    FIREWALL_STATUS="\
If you have connection problems, it may be that your router or cloud provider
blocks inbound connections, even though your machine seems to allow them."
  fi
  FIREWALL_STATUS="\
${FIREWALL_STATUS}

Make sure to open the following ports on your firewall, router or cloud provider:
- Management port ${API_PORT}, for TCP
- Access key port ${ACCESS_KEY_PORT}, for TCP and UDP

If you use UFW, you can allow these ports with:
  sudo ufw allow ${API_PORT}/tcp
  sudo ufw allow ${ACCESS_KEY_PORT}/tcp
  sudo ufw allow ${ACCESS_KEY_PORT}/udp
"
}

function set_hostname() {
  # These are URLs that return the client's apparent IP address.
  # We have more than one to try in case one starts failing
  # (e.g. https://github.com/OutlineFoundation/outline-server/issues/776).
  local -ar urls=(
    'https://icanhazip.com/'
    'https://ipinfo.io/ip'
    'https://domains.google.com/checkip'
  )
  for url in "${urls[@]}"; do
    PUBLIC_HOSTNAME="$(fetch --ipv4 "${url}")" && return
  done
  echo "Failed to determine the server's IP address.  Try using --hostname <server IP>." >&2
  return 1
}

install_shadowbox() {
  local MACHINE_TYPE
  MACHINE_TYPE="$(uname -m)"
  if [[ "${MACHINE_TYPE}" != "x86_64" && "${MACHINE_TYPE}" != "aarch64" && "${MACHINE_TYPE}" != "arm64" ]]; then
    log_error "Unsupported machine type: ${MACHINE_TYPE}. Supported architectures: x86_64, aarch64/arm64."
    exit 1
  fi

  # Make sure we don't leak readable files to other users.
  umask 0007

  export CONTAINER_NAME="${CONTAINER_NAME:-shadowbox}"

  run_step "Verifying that Docker is installed" verify_docker_installed
  run_step "Verifying that Docker daemon is running" verify_docker_running

  log_for_sentry "Creating Outline directory"
  export SHADOWBOX_DIR="${SHADOWBOX_DIR:-/opt/outline}"
  mkdir -p "${SHADOWBOX_DIR}"
  chmod u+s,ug+rwx,o-rwx "${SHADOWBOX_DIR}"

  log_for_sentry "Setting API port"
  API_PORT="${FLAGS_API_PORT}"
  if (( API_PORT == 0 )); then
    API_PORT=${SB_API_PORT:-$(get_random_port)}
  fi
  readonly API_PORT
  readonly ACCESS_CONFIG="${ACCESS_CONFIG:-${SHADOWBOX_DIR}/access.txt}"
  readonly SB_IMAGE="${SB_IMAGE:-quay.io/outline/shadowbox:stable}"

  PUBLIC_HOSTNAME="${FLAGS_HOSTNAME:-${SB_PUBLIC_IP:-}}"
  if [[ -z "${PUBLIC_HOSTNAME}" ]]; then
    run_step "Setting PUBLIC_HOSTNAME to external IP" set_hostname
  fi
  readonly PUBLIC_HOSTNAME

  # If $ACCESS_CONFIG is already populated, make a backup before clearing it.
  log_for_sentry "Initializing ACCESS_CONFIG"
  if [[ -s "${ACCESS_CONFIG}" ]]; then
    # Note we can't do "mv" here as do_install_server.sh may already be tailing
    # this file.
    cp "${ACCESS_CONFIG}" "${ACCESS_CONFIG}.bak" && true > "${ACCESS_CONFIG}"
  fi

  # Make a directory for persistent state
  run_step "Creating persistent state dir" create_persisted_state_dir
  run_step "Generating secret key" generate_secret_key
  run_step "Generating TLS certificate" generate_certificate
  run_step "Generating SHA-256 certificate fingerprint" generate_certificate_fingerprint
  run_step "Writing config" write_config

  # TODO(dborkan): if the script fails after docker run, it will continue to fail
  # as the names shadowbox and watchtower will already be in use.  Consider
  # deleting the container in the case of failure (e.g. using a trap, or
  # deleting existing containers on each run).
  run_step "Starting Shadowbox" start_shadowbox
  # TODO(fortuna): Don't wait for Shadowbox to run this.
  run_step "Starting Watchtower" start_watchtower

  readonly PUBLIC_API_URL="https://${PUBLIC_HOSTNAME}:${API_PORT}/${SB_API_PREFIX}"
  readonly LOCAL_API_URL="https://localhost:${API_PORT}/${SB_API_PREFIX}"
  run_step "Waiting for Outline server to be healthy" wait_shadowbox
  run_step "Creating first user" create_first_user
  run_step "Adding API URL to config" add_api_url_to_config

  FIREWALL_STATUS=""
  run_step "Checking host firewall" check_firewall

  # Echos the value of the specified field from ACCESS_CONFIG.
  # e.g. if ACCESS_CONFIG contains the line "certSha256:1234",
  # calling $(get_field_value certSha256) will echo 1234.
  function get_field_value {
    grep "$1" "${ACCESS_CONFIG}" | sed "s/$1://"
  }

  # Output JSON.  This relies on apiUrl and certSha256 (hex characters) requiring
  # no string escaping.  TODO: look for a way to generate JSON that doesn't
  # require new dependencies.
  cat <<END_OF_SERVER_OUTPUT

CONGRATULATIONS! Your Outline server is up and running.

To manage your Outline server, please copy the following line (including curly
brackets) into Step 2 of the Outline Manager interface:

$(echo -e "\033[1;32m{\"apiUrl\":\"$(get_field_value apiUrl)\",\"certSha256\":\"$(get_field_value certSha256)\"}\033[0m")

${FIREWALL_STATUS}
END_OF_SERVER_OUTPUT
} # end of install_shadowbox

function is_valid_port() {
  (( 0 < "$1" && "$1" <= 65535 ))
}

function escape_json_string() {
  local input=$1
  for ((i = 0; i < ${#input}; i++)); do
    local char="${input:i:1}"
    local escaped="${char}"
    case "${char}" in
      $'"' ) escaped="\\\"";;
      $'\\') escaped="\\\\";;
      *)
        if [[ "${char}" < $'\x20' ]]; then
          case "${char}" in 
            $'\b') escaped="\\b";;
            $'\f') escaped="\\f";;
            $'\n') escaped="\\n";;
            $'\r') escaped="\\r";;
            $'\t') escaped="\\t";;
            *) escaped=$(printf "\u%04X" "'${char}")
          esac
        fi;;
    esac
    echo -n "${escaped}"
  done
}

function parse_flags() {
  local params
  params="$(getopt --longoptions hostname:,api-port:,keys-port: -n "$0" -- "$0" "$@")"
  eval set -- "${params}"

  while (( $# > 0 )); do
    local flag="$1"
    shift
    case "${flag}" in
      --hostname)
        FLAGS_HOSTNAME="$1"
        shift
        ;;
      --api-port)
        FLAGS_API_PORT=$1
        shift
        if ! is_valid_port "${FLAGS_API_PORT}"; then
          log_error "Invalid value for ${flag}: ${FLAGS_API_PORT}" >&2
          exit 1
        fi
        ;;
      --keys-port)
        FLAGS_KEYS_PORT=$1
        shift
        if ! is_valid_port "${FLAGS_KEYS_PORT}"; then
          log_error "Invalid value for ${flag}: ${FLAGS_KEYS_PORT}" >&2
          exit 1
        fi
        ;;
      --)
        break
        ;;
      *) # This should not happen
        log_error "Unsupported flag ${flag}" >&2
        display_usage >&2
        exit 1
        ;;
    esac
  done
  if (( FLAGS_API_PORT != 0 && FLAGS_API_PORT == FLAGS_KEYS_PORT )); then
    log_error "--api-port must be different from --keys-port" >&2
    exit 1
  fi
  return 0
}

function main() {
  trap finish EXIT
  declare FLAGS_HOSTNAME=""
  declare -i FLAGS_API_PORT=0
  declare -i FLAGS_KEYS_PORT=0
  parse_flags "$@"
  install_shadowbox
}

main "$@"
