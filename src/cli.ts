#!/usr/bin/env node

import { DeviceOptions } from "playactor/dist/cli/options";
import { Discovery } from "playactor/dist/discovery";
import { userInfo } from "os";
import readline from "readline";
import { DiskCredentialsStorage } from "playactor/dist/credentials/disk-storage";

// --credentials <path>: where to save the login (must match the plugin's
// credentialsPath setting, if set)
const credentialsArg = process.argv.indexOf("--credentials");
const credentialsPath =
  credentialsArg === -1 ? undefined : process.argv[credentialsArg + 1];

const connect = async (deviceId) => {
  try {
    const opt = new DeviceOptions();
    opt.dontAutoOpenUrls = true;
    opt.deviceHostId = deviceId;
    opt.credentialsPath = credentialsPath;

    console.log(`Connecting to <${deviceId}>...`);

    const device = await opt.findDevice();
    const conn = await device.openConnection();
    console.log(
      "Connection successful, wait a bit so we can safely close the connection..."
    );
    await conn.close();

    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : err;
    console.error(message);
    return false;
  }
};

const confirm = (deviceName) => {
  const input = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    input.question(`Authenticate to ${deviceName}? (y/n) `, (response) => {
      input.close();
      resolve(response.toLowerCase() === "y");
    });
  });
};

const discover = async () => {
  const discovery = new Discovery();
  const devices = discovery.discover();

  let success = false;
  for await (const device of devices) {
    console.log("Discovered device:", device);
    const confirmed = await confirm(device.name);
    if (confirmed) {
      // track if there were any successful connections
      success = (await connect(device.id)) || success;
    }

    console.log("\nDiscovering next device...");
  }

  return success;
};

if (credentialsArg !== -1 && !credentialsPath) {
  console.error("Usage: homebridge-playstation-login [--credentials <path>]");
  process.exit(1);
}

const storage = new DiskCredentialsStorage(credentialsPath);
console.log(
  `Logging in as user "${userInfo().username}"; credentials go to ${storage.filePath}`
);

discover()
  .then((success) => {
    if (success) {
      console.log("\nPlease restart Homebridge now!");
    } else {
      console.error("\nDid not authenticate to any consoles.");
    }
  })
  .catch((err) => console.error(err));
