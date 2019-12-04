// Copyright 2019 The Outline Authors
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

package main

import (
  "flag"
  "fmt"
  "log"
  "os"

  "golang.org/x/sys/windows/registry"
)

const (
  // netAdaptersKeyPath is the registry location of the system's network adapters.
  netAdaptersKeyPath = `SYSTEM\CurrentControlSet\Control\Class\{4D36E972-E325-11CE-BFC1-08002BE10318}`
  // netConfigKeyPath is the registry location of the network adapters network configuration.
  netConfigKeyPath = `SYSTEM\CurrentControlSet\Control\Network\{4D36E972-E325-11CE-BFC1-08002BE10318}`
)

// findNetworkAdapterName searches the Windows registry for the name of a network adapter with
// `componentID`. Since there may be more than one network adapter with the same component ID,
// selects the most recently installed device in the event of a conflict.
// Returns an empty string and an error if the device name cannot be found.
func findNetworkAdapterName(componentID string) (string, error) {
  netAdaptersKey, err := registry.OpenKey(registry.LOCAL_MACHINE, netAdaptersKeyPath, registry.READ)
  if err != nil {
    return "", fmt.Errorf("Failed to open the network adapter registry, %v", err)
  }
  defer netAdaptersKey.Close()

  // List all network adapters.
  adapterKeys, err := netAdaptersKey.ReadSubKeyNames(-1)
  if err != nil {
    return "", err
  }

  // Keep track of the most recently installed adapter name.
  var name string
  var installTimestamp uint64

  for _, k := range adapterKeys {
    adapterKey, err := registry.OpenKey(registry.LOCAL_MACHINE, netAdaptersKeyPath + "\\" + k, registry.READ)
    if err != nil {
      continue
    }
    defer adapterKey.Close()

    adapterComponentID, _, err := adapterKey.GetStringValue("ComponentId")
    if err != nil {
      continue
    }
    log.Println("Found", adapterComponentID)
    if adapterComponentID != componentID {
      continue
    }

    adapterInstallTimestamp, _, err := adapterKey.GetIntegerValue("NetworkInterfaceInstallTimestamp")
    if err != nil {
      log.Println("Failed to read adapter install timestamp:", err)
      continue
    }
    log.Println("\tInstall timestamp", adapterInstallTimestamp)

    adapterNetConfigID, _, err := adapterKey.GetStringValue("NetCfgInstanceId")
    if err != nil {
      log.Println("Failed to read network configuration ID:", err)
      continue
    }
    adapterConfigKeyPath := fmt.Sprintf("%s\\%s\\Connection", netConfigKeyPath, adapterNetConfigID)
    adapterConfigKey, err := registry.OpenKey(registry.LOCAL_MACHINE, adapterConfigKeyPath, registry.READ)
    if err != nil {
      log.Println("Failed to open network configuration key:", err)
      continue
    }
    defer adapterConfigKey.Close()

    adapterName, _, err := adapterConfigKey.GetStringValue("Name")
    if err != nil {
      log.Println("Failed to read adapter name:", err)
      continue
    }
    log.Println("\tName", adapterName)

    if adapterInstallTimestamp > installTimestamp {
      // Found a newer device.
      installTimestamp = adapterInstallTimestamp
      name = adapterName
    }
  }

  if name == "" {
    err = fmt.Errorf("Could not find the network adapter with the specified component ID")
  }
  return name, err
}


func main() {
  componentID := flag.String("componentid", "tap0901", "Hardware component ID of the network adapter")
  flag.Parse()

  // Remove timestamps, output to stderr by default.
  log.SetFlags(0)

  name, err := findNetworkAdapterName(*componentID)
  if err != nil {
    log.Fatalf(err.Error())
  }
  // Output the name to stdout.
  log.SetOutput(os.Stdout)
  log.Print(name)
}
