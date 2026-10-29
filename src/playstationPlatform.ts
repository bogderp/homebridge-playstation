import {
  API,
  Logger,
  PlatformConfig,
  Service,
  Characteristic,
  IndependentPlatformPlugin,
} from "homebridge";

import { homedir, userInfo } from "os";
import { PlaystationAccessory } from "./playstationAccessory";
import { DiskCredentialsStorage } from "playactor/dist/credentials/disk-storage";
import { Discovery } from "playactor/dist/discovery";
import { IDiscoveredDevice } from "playactor/dist/discovery/model";

export interface PlaystationPlatformConfig extends PlatformConfig {
  pollInterval?: number;
  overrides?: Array<{ deviceId: string; name?: string }>;
  apps?: Array<{ id: string; name: string }>;
  credentialsPath?: string;
}

export class PlaystationPlatform implements IndependentPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
    this.api.hap.Characteristic;

  public readonly kDefaultPollInterval = 15_000;

  // where playactor keeps the console logins; shared by every accessory
  public readonly credentialsStorage: DiskCredentialsStorage;

  constructor(
    public readonly log: Logger,
    public readonly config: PlaystationPlatformConfig,
    public readonly api: API
  ) {
    this.log.debug("Config", config);

    // Homebridge doesn't expand "~" in config values
    const credentialsPath = config.credentialsPath?.replace(/^~(?=\/|$)/, homedir());
    this.credentialsStorage = new DiskCredentialsStorage(
      credentialsPath || undefined
    );
    this.log.debug(
      "Reading credentials from",
      this.credentialsStorage.filePath
    );
    this.log.info("Discovering devices...");

    this.discoverDevices().catch((err) => {
      this.log.error((err as Error).message);
    });
  }

  async discoverDevices() {
    const discovery = new Discovery();
    const devices = discovery.discover();

    for await (const deviceInformation of devices) {
      this.log.debug("Discovered device:", deviceInformation);
      await this.checkCredentials(deviceInformation);
      new PlaystationAccessory(this, deviceInformation);
    }
  }

  // A login made as another user (eg: root, or the user you SSH in as) is
  // saved in that user's home directory, where Homebridge never looks
  private async checkCredentials(device: IDiscoveredDevice) {
    const { filePath } = this.credentialsStorage;

    let found: boolean;
    try {
      found = (await this.credentialsStorage.read(device.id)) !== null;
    } catch (err) {
      this.log.warn(
        `Could not read the credentials file ${filePath}: ${(err as Error).message}`
      );
      return;
    }

    if (found) {
      this.log.debug(`Found credentials for ${device.name} in ${filePath}`);
      return;
    }

    let user: string;
    try {
      user = `"${userInfo().username}"`;
    } catch {
      user = "the user Homebridge runs as";
    }

    const loginOption = this.config.credentialsPath
      ? ` --credentials ${filePath}`
      : "";
    this.log.warn(
      `No login for ${device.name} (${device.id}) in ${filePath}. ` +
        `Homebridge runs as ${user}, so run homebridge-playstation-login${loginOption} as ${user}, then restart Homebridge. ` +
        `Until then Home can show whether it is on, but not turn it on or off.`
    );
  }
}
