:: Copyright 2018 The Outline Authors
::
:: Licensed under the Apache License, Version 2.0 (the "License");
:: you may not use this file except in compliance with the License.
:: You may obtain a copy of the License at
::
::      http://www.apache.org/licenses/LICENSE-2.0
::
:: Unless required by applicable law or agreed to in writing, software
:: distributed under the License is distributed on an "AS IS" BASIS,
:: WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
:: See the License for the specific language governing permissions and
:: limitations under the License.

:: Accepts one argument, the system's architecture (amd64 or i386).

@echo off

set DEVICE_NAME=outline-tap0

:: Check whether the device already exists.
netsh interface show interface name=%DEVICE_NAME% >nul
if %errorlevel% equ 0 (
  echo %DEVICE_NAME% already exists.
  exit /b
)

:: Add the device, recording the names of devices before and after to help
:: us find the name of the new device.
::
:: Note:
::  - While we could limit the search to devices having ServiceName=tap0901,
::    that will cause wmic to output just "no instances available" when there
::    are no other TAP devices present, messing up the diff.
::  - We do not use findstr, etc., to strip blank lines because those ancient tools
::    typically don't understand/output non-Latin characters (wmic *does*, even on
::    Windows 7).
set BEFORE_DEVICES=%tmp%\outlineinstaller-tap-devices-before.txt
set AFTER_DEVICES=%tmp%\outlineinstaller-tap-devices-after.txt

echo Storing current network device list...
wmic nic where "netconnectionid is not null" get netconnectionid > %BEFORE_DEVICES%
type %BEFORE_DEVICES%

echo Creating TAP network device...
tap-windows6\tapinstall install tap-windows6\OemVista.inf tap0901
if %errorlevel% neq 0 (
  echo Could not create TAP network device. >&2
  exit /b 1
)
echo Storing new network device list...
wmic nic where "netconnectionid is not null" get netconnectionid > %AFTER_DEVICES%
type %AFTER_DEVICES%

:: Find the name of the new device and rename it.
::
:: Obviously, this command is a beast; roughly what it does, in this order, is:
::  - perform a diff on the *trimmed* (in case wmic uses different column widths) before and after
::    text files
::  - remove leading/trailing space and blank lines with trim()
::  - store the result in NEW_DEVICE
::  - print NEW_DEVICE, for debugging (though non-Latin characters may appear as ?)
::  - invoke netsh
::
:: Running all this in one go helps reduce the need to deal with temporary
:: files and the character encoding headaches that follow.
::
:: Note that we pipe input from /dev/null to prevent Powershell hanging forever
:: waiting on EOF.
echo Searching for new TAP network device name...
powershell "(compare-object (cat %BEFORE_DEVICES%).trim() (cat %AFTER_DEVICES%).trim() | format-wide -autosize | out-string).trim() | set-variable NEW_DEVICE; write-host \"New TAP device name: ${NEW_DEVICE}\"; netsh interface set interface name = \"${NEW_DEVICE}\" newname = \"%DEVICE_NAME%\"" <nul
if %errorlevel% neq 0 (
  echo Could not find or rename new TAP network device. >&2
  exit /b 1
)

echo Configuring new TAP network device...

:: Give the device an IP address.
:: 10.0.85.x is a guess which we hope will work for most users (Docker for
:: Windows uses 10.0.75.x by default): if the address is already in use the
:: script will fail and the installer will show an error message to the user.
:: TODO: Actually search the system for an unused subnet or make the subnet
::       configurable in the Outline client.
netsh interface ip set address %DEVICE_NAME% static 10.0.85.2 255.255.255.0
if %errorlevel% neq 0 (
  echo Could not set TAP network device subnet. >&2
  exit /b 1
)

:: Windows has no system-wide DNS server; each network device can have its
:: "own" set of DNS servers. Windows seems to use the DNS server(s) of the
:: network device associated with the default gateway. This is good for us
:: as it means we do not have to modify the DNS settings of any other network
:: device in the system. Configure with OpenDNS and Dyn resolvers.
netsh interface ip set dnsservers %DEVICE_NAME% static address=208.67.222.222
if %errorlevel% neq 0 (
  echo Could not configure TAP device primary DNS. >&2
  exit /b 1
)
netsh interface ip add dnsservers %DEVICE_NAME% 216.146.35.35 index=2
if %errorlevel% neq 0 (
  echo Could not configure TAP device secondary DNS. >&2
  exit /b 1
)
