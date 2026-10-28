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
  DeviceType,
  IDiscoveredDevice,
} from "playactor/dist/discovery/model";
import { RemoteOperation } from "playactor/dist/socket/remote";
import { KeyPress } from "playactor/dist/socket/proc/remote-control";

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

  // keys pressed while a previous batch is still being sent
  private pendingKeys: KeyPress[] = [];
  private sendingKeys = false;
  private remoteUnsupportedLogged = false;

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

    this.tvService
      .getCharacteristic(this.Characteristic.RemoteKey)
      .onSet(this.setRemoteKey.bind(this));

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

  private notifyCharacteristicsUpdate(recovered = false) {
    const active = this.tvService.getCharacteristic(
      this.platform.Characteristic.Active
    );
    const isAwake = this.deviceInformation.status === DeviceStatus.AWAKE;

    if (this.reachable === false) {
      // an unreachable console shows as "Not responding" in the Home app
      // rather than "Off". HAP cannot push errors, so the Home app shows it
      // the next time it reads the value
      active.updateValue(this.communicationFailure());
    } else if (recovered) {
      // HAP only sends an event when the value changed, and without one the
      // Home app keeps showing "Not responding"
      active.sendEventNotification(isAwake);
    } else {
      active.updateValue(isAwake);
    }

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
    let recovered = false;

    try {
      await this.discoverDevice();
      recovered = this.reachable === false;
      this.setReachable(true);
    } catch (err) {
      this.setReachable(false, err as Error);
      // If we can't discover the device, it's probably OFF
      this.deviceInformation.status = DeviceStatus.STANDBY;
    } finally {
      this.pollInFlight = false;
      this.notifyCharacteristicsUpdate(recovered);
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

  private toRemoteOperation(
    value: CharacteristicValue
  ): RemoteOperation | undefined {
    const { RemoteKey } = this.Characteristic;
    switch (value) {
      case RemoteKey.ARROW_UP:
        return RemoteOperation.Up;
      case RemoteKey.ARROW_DOWN:
        return RemoteOperation.Down;
      case RemoteKey.ARROW_LEFT:
        return RemoteOperation.Left;
      case RemoteKey.ARROW_RIGHT:
        return RemoteOperation.Right;
      case RemoteKey.SELECT:
        return RemoteOperation.Enter;
      case RemoteKey.BACK:
        return RemoteOperation.Back;
      case RemoteKey.INFORMATION:
        return RemoteOperation.Option;
      case RemoteKey.EXIT:
        return RemoteOperation.PS;
      default:
        return undefined;
    }
  }

  private logRemoteUnsupported(reason: string) {
    if (this.remoteUnsupportedLogged) {
      this.log.debug(`Remote key ignored: ${reason}`);
      return;
    }
    this.remoteUnsupportedLogged = true;
    this.log.info(`The iPhone remote is not supported: ${reason}`);
  }

  private setRemoteKey(value: CharacteristicValue) {
    this.log.debug(`setRemoteKey:`, value);

    // playactor can only send keys over the PS4 second screen connection,
    // the PS5 Remote Play connection has no remote control
    if (this.deviceInformation.type === DeviceType.PS5) {
      this.logRemoteUnsupported(
        "the PS5 only accepts remote keys inside a Remote Play stream"
      );
      return;
    }

    const key = this.toRemoteOperation(value);
    if (key === undefined) {
      this.log.debug(`No PlayStation button for remote key:`, value);
      return;
    }

    // opening a connection wakes the console, so only send to an awake one
    if (this.deviceInformation.status !== DeviceStatus.AWAKE) {
      this.log.debug(`Console is not awake, ignoring remote key`);
      return;
    }

    if (this.lockSetOn) {
      this.log.debug(
        `Previous request is still in progress, ignoring remote key`
      );
      return;
    }

    this.pendingKeys.push({ key });
    this.sendPendingKeys();
  }

  private async sendPendingKeys() {
    if (this.sendingKeys) {
      return;
    }

    this.sendingKeys = true;

    try {
      // each connection takes a couple of seconds to open, so keys pressed
      // meanwhile are sent together on the next one
      while (this.pendingKeys.length > 0) {
        const keys = this.pendingKeys.splice(0);
        const device = await this.discoverDevice();
        const connection = await device.openConnection();

        try {
          if (!connection.sendKeys) {
            this.pendingKeys = [];
            this.logRemoteUnsupported(
              "the console is logged in with Remote Play credentials, which have no remote control"
            );
            return;
          }

          this.log.debug(`Sending remote keys:`, keys);
          await connection.sendKeys(keys);
        } finally {
          await connection.close();
        }
      }
    } catch (err) {
      this.pendingKeys = [];
      this.log.error((err as Error).message);
    } finally {
      this.sendingKeys = false;
    }
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
