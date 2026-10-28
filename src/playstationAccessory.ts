import {
  API,
  Characteristic,
  CharacteristicValue,
  Logging,
  PlatformAccessory,
  Service,
} from "homebridge";
import { Device } from "playactor/dist/device";
import { ConnectionIntent } from "playactor/dist/device/model";
import {
  DeviceStatus,
  IDiscoveredDevice,
} from "playactor/dist/discovery/model";

import { PlaystationPlatform } from "./playstationPlatform";
import { PLUGIN_NAME } from "./settings";

export class PlaystationAccessory {
  private readonly accessory: PlatformAccessory;
  private readonly tvService: Service;

  private readonly api: API = this.platform.api;
  private readonly log: Logging;
  private readonly Service: typeof Service = this.platform.Service;
  private readonly Characteristic: typeof Characteristic =
    this.platform.Characteristic;

  private lockUpdate = false;
  private pollInFlight = false;

  // undefined until the first poll, so the first result is not reported as a change
  private reachable: boolean | undefined;
  private lockSetOn = false;

  private tick: NodeJS.Timeout | undefined;

  private lockTimeout: NodeJS.Timeout | undefined;
  private readonly kLockTimeout = 20_000;

  // list of titles that can be started through Home app
  private titleIDs: unknown[] = [];

  constructor(
    private readonly platform: PlaystationPlatform,
    private deviceInformation: IDiscoveredDevice
  ) {
    const uuid = this.api.hap.uuid.generate(deviceInformation.id);
    const overrides = this.getOverrides();

    const deviceName = overrides?.name || deviceInformation.name;

    // @ts-expect-error - private property
    this.log = {
      ...this.platform.log,
      prefix: this.platform.log.prefix + `/${deviceName}`,
    };

    this.accessory = new this.api.platformAccessory<{
      deviceInformation: IDiscoveredDevice;
    }>(deviceName, uuid);
    this.accessory.category = this.api.hap.Categories.TV_SET_TOP_BOX;

    this.accessory
      .getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, "Sony")
      .setCharacteristic(this.Characteristic.Model, deviceInformation.type)
      .setCharacteristic(this.Characteristic.SerialNumber, deviceInformation.id)
      .setCharacteristic(
        this.Characteristic.FirmwareRevision,
        deviceInformation.systemVersion
      );

    this.tvService =
      this.accessory.getService(this.Service.Television) ||
      this.accessory.addService(this.Service.Television);

    this.tvService
      .setCharacteristic(this.Characteristic.ConfiguredName, deviceName)
      .setCharacteristic(
        this.platform.Characteristic.SleepDiscoveryMode,
        this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
      );

    this.tvService
      .getCharacteristic(this.Characteristic.Active)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    // These characteristics are required but not implemented yet
    this.tvService
      .getCharacteristic(this.Characteristic.RemoteKey)
      .onSet((newValue: CharacteristicValue) => {
        this.log.debug(`Set RemoteKey is not implemented yet`, newValue);
      });

    this.tvService.setCharacteristic(this.Characteristic.ActiveIdentifier, 0);

    this.setTitleList();

    this.tvService
      .getCharacteristic(this.Characteristic.ActiveIdentifier)
      .onSet(this.setTitleSwitchState.bind(this));

    this.tick = setInterval(
      this.updateDeviceInformations.bind(this),
      this.platform.config.pollInterval || this.platform.kDefaultPollInterval
    );

    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
  }

  private getOverrides() {
    const overrides = this.platform.config.overrides || [];
    return overrides.find(
      (override) => override.deviceId === this.deviceInformation.id
    );
  }

  private setTitleList() {
    const titleList = this.platform.config.apps || [];

    if (titleList.length === 0) {
      return;
    }

    // if nothing selected yet, add a placeholder
    this.addTitleToList("CUSAXXXXXX", "None", 0);
    titleList.forEach((title, index) => {
      this.log.debug(`Adding input for title: `, title);
      this.addTitleToList(title.id, title.name, index + 1);
    });
  }

  private addTitleToList(titleId: string, titleName: string, index: number) {
    const titleInputSource = new this.Service.InputSource(titleName, titleId);
    titleInputSource
      .setCharacteristic(this.Characteristic.Identifier, index)
      .setCharacteristic(this.Characteristic.Name, titleName)
      .setCharacteristic(this.Characteristic.ConfiguredName, titleName)
      .setCharacteristic(
        this.Characteristic.IsConfigured,
        this.Characteristic.IsConfigured.CONFIGURED
      )
      .setCharacteristic(
        this.Characteristic.InputSourceType,
        this.Characteristic.InputSourceType.APPLICATION
      )
      .setCharacteristic(
        this.Characteristic.CurrentVisibilityState,
        this.Characteristic.CurrentVisibilityState.SHOWN
      );

    this.accessory.addService(titleInputSource);
    this.tvService.addLinkedService(titleInputSource);

    this.titleIDs.push(titleId);
  }

  private async discoverDevice() {
    // Wrapper to get the device and making sure you always call .discover() before using the device,
    // otherwise you will get an "Error: Unexpected discovery message"
    const device = Device.withId(this.deviceInformation.id);
    this.deviceInformation = await device.discover();
    return device;
  }

  private notifyCharacteristicsUpdate() {
    // an unreachable console shows as "Not responding" in the Home app
    // rather than "Off"
    this.tvService
      .getCharacteristic(this.platform.Characteristic.Active)
      .updateValue(
        this.reachable === false
          ? this.communicationFailure()
          : this.deviceInformation.status === DeviceStatus.AWAKE
      );

    const runningAppTitle = this.titleIDs.indexOf(
      this.deviceInformation.extras["running-app-titleid"] || 0
    );
    this.tvService
      .getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
      .updateValue(runningAppTitle == -1 ? 0 : runningAppTitle);

    this.log.debug(`Device status updated to:`, this.deviceInformation.status);
  }

  private async updateDeviceInformations() {
    // pollInFlight is separate from lockUpdate: setOn releasing its locks
    // must not let a second poll start while one is still running
    if (this.pollInFlight || this.lockUpdate) {
      return;
    }

    this.pollInFlight = true;

    try {
      await this.discoverDevice();
      this.setReachable(true);
    } catch (err) {
      this.setReachable(false, err as Error);
      // If we can't discover the device, it's probably OFF
      this.deviceInformation.status = DeviceStatus.STANDBY;
    } finally {
      this.pollInFlight = false;
      this.notifyCharacteristicsUpdate();
    }
  }

  private setReachable(reachable: boolean, err?: Error) {
    const previous = this.reachable;
    this.reachable = reachable;

    if (previous === reachable) {
      if (err) {
        this.log.debug(err.message);
      }
      return;
    }

    if (!reachable) {
      this.log.warn(
        `Console is not reachable, it is probably powered off or disconnected from the network (${err?.message}). Logging this again only once it is back.`
      );
    } else if (previous === false) {
      this.log.info(`Console is reachable again`);
    }
  }

  private addLocks() {
    this.lockSetOn = true;
    this.lockUpdate = true;
    this.lockTimeout = setTimeout(() => {
      this.log.debug(`Removing locks due to timeout`);
      this.releaseLocks();
    }, this.kLockTimeout);
  }

  private releaseLocks() {
    this.lockSetOn = false;
    this.lockUpdate = false;
    if (this.lockTimeout) {
      clearTimeout(this.lockTimeout);
    }
  }

  private setOn(value: CharacteristicValue) {
    this.log.debug(`setOn:`, value);

    if (this.lockSetOn) {
      this.log.info(
        `Previous request is still in progress (this can take up to ${this.kLockTimeout / 1000}s), ignoring this one`
      );
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.RESOURCE_BUSY
      );
    }

    this.log.debug("Discovering device...");

    this.addLocks();

    this.discoverDevice()
      .then(async (device) => {
        if (
          (value == true &&
            this.deviceInformation.status === DeviceStatus.AWAKE) ||
          (value == false &&
            this.deviceInformation.status === DeviceStatus.STANDBY)
        ) {
          this.log.debug(`Already in desired state`);
          this.notifyCharacteristicsUpdate();
          return;
        }

        this.log.debug(`Opening connection...`);
        // a STANDBY connection skips the Remote Play login, which recent
        // PS5 firmware often never answers
        const connection = await device.openConnection({
          intent: value ? ConnectionIntent.LOGIN : ConnectionIntent.STANDBY,
        });

        if (value) {
          this.log.debug(`Waking device...`);
          await device.wake();
        } else {
          this.log.debug(`Standby device...`);
          await connection.standby();
        }

        this.log.debug(`Closing connection...`);
        await connection.close();

        this.log.debug(`Connection closed`);
      })
      .catch((err) => {
        this.log.error((err as Error).message);
      })
      .finally(() => {
        this.releaseLocks();
        // refresh now instead of waiting for the next poll
        this.updateDeviceInformations();
      });
  }

  private async getOn(): Promise<CharacteristicValue> {
    if (this.reachable === false) {
      throw this.communicationFailure();
    }
    return this.deviceInformation.status === DeviceStatus.AWAKE;
  }

  private communicationFailure() {
    return new this.api.hap.HapStatusError(
      this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE
    );
  }

  private async setTitleSwitchState(value: CharacteristicValue) {
    this.log.debug(`setTitleSwitchState: `, value);

    const requestedTitle = (this.titleIDs[value as number] as string) || null;

    if (!requestedTitle) {
      this.log.debug(`No title found for index: `, value);
      return;
    }

    if (this.lockSetOn) {
      this.log.info(
        `Previous request is still in progress (this can take up to ${this.kLockTimeout / 1000}s), ignoring this one`
      );
      throw new this.api.hap.HapStatusError(
        this.api.hap.HAPStatus.RESOURCE_BUSY
      );
    }

    this.addLocks();

    this.discoverDevice()
      .then(async (device) => {
        if (
          this.deviceInformation.extras["running-app-titleid"] ===
          requestedTitle
        ) {
          this.log.debug(`Title already running`);
          this.notifyCharacteristicsUpdate();
          return;
        }

        this.log.debug(`Starting title ${requestedTitle} ...`);
        const connection = await device.openConnection({
          intent: ConnectionIntent.START_TITLE,
        });

        await connection.startTitleId?.(requestedTitle);

        this.log.debug(`Closing connection...`);
        await connection.close();

        this.log.debug(`Connection closed`);
      })
      .catch((err) => {
        this.log.error((err as Error).message);
      })
      .finally(() => {
        this.releaseLocks();
      });
  }
}
