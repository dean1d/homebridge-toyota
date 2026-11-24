# homebridge-toyota

[![npm version](https://img.shields.io/npm/v/homebridge-toyota)](https://www.npmjs.com/package/homebridge-toyota)
[![npm weekly downloads](https://img.shields.io/npm/dw/homebridge-toyota)](https://www.npmjs.com/package/homebridge-toyota)

A Homebridge accessory for Toyota Remote Connect. Apple Home gets a door lock control and momentary remote-start and remote-stop switches. The lock reads Toyota's last reported status, which can lag behind the vehicle. Lock and unlock wait up to 60 seconds for that status to confirm the change. The plugin reuses a status for 30 seconds, so opening Apple Home repeatedly doesn't flood Toyota with requests.

## Requirements

- Node.js 22.x, 24.x, or 26.13.1 and later in the 26.x series. Requires Homebridge 1.8 or 2.x.
- A compatible North American Toyota and an active Toyota Remote Connect subscription.
- Version 0.2.0 and later run entirely in Node.js. Homebridge accessory controls were tested with simulated Toyota responses on Node.js 26.13.1. Live testing with the 2026 Sienna is pending.

## Installation and setup

Install **Toyota Remote Connect** from the Homebridge Plugins tab and open its settings.

1. Enter your Toyota account email and password, then select **Sign in to Toyota**. Enter the verification code if Toyota requests one.
2. Select the VIN for your vehicle. If Toyota returns one vehicle, its VIN is filled in automatically.
3. Under **Show in Apple Home**, choose **Door lock and unlock**, **Remote start** (which also adds a remote-stop switch), or both. Both controls are enabled by default.
4. Select **Save Toyota settings** and restart Homebridge.

Toyota credentials are used for sign-in. The plugin saves the resulting session under Homebridge's storage directory, where it can refresh the session as needed. Keep that session file private.

Existing installations can keep using their configured session file. To switch to automatic storage, sign in through the plugin settings, then save and restart Homebridge.

## Manual configuration

Add an entry to the existing Homebridge `accessories` array. The default session lives at `homebridge-toyota/session.json` under Homebridge's storage directory. For installations without the Homebridge UI, run `homebridge-toyota-login` with the absolute path to that file.

```json
{
  "accessory": "Toyota",
  "name": "Sienna",
  "vin": "YOUR_17_CHARACTER_VIN",
  "showDoorLock": true,
  "showRemoteStart": true
}
```

Restart Homebridge and open Apple Home. Test the door lock with the Sienna in view. Test remote start outdoors with the vehicle empty. The start and stop switches reset after each request. If Apple Home times out, check the Toyota app before trying again. Keep the remote-start switch out of unattended automations.


## Support

Use [GitHub Issues](https://github.com/dean1d/homebridge-toyota/issues) for reproducible bugs and feature requests. Include the vehicle model and year, Homebridge and Node.js versions, and the error shown in the Homebridge log. Remove VINs, credentials, verification codes, and session data from anything you share.

## Credits

- [orienw](https://github.com/orienw) and contributors for the [Toyota North America Home Assistant integration](https://github.com/orienw/ha-toyota-na), which served as a reference for the Node.js sign-in and remote-command implementation.
- [widewing](https://github.com/widewing) and contributors for the [original Toyota North America integration](https://github.com/widewing/ha-toyota-na).

## Disclaimer

- This community project operates independently of Toyota and Apple and carries no endorsement or support from either company.
- Toyota can change its undocumented Remote Connect interface without notice. Features depend on your vehicle, account, and subscription.
- Use remote start outdoors with the vehicle empty and follow Toyota’s operating instructions.

## Support & Donations

This plugin is free and open source. If it saved you some time or frustration and you'd like to say thanks, any support is greatly appreciated!

<a href="https://buymeacoffee.com/dean1d" target="_blank">
  <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-dean1d-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" />
</a>

<a href="https://cash.app/$dkoenigBOA" target="_blank">
  <img src="https://img.shields.io/badge/Cash%20App-%24dkoenigBOA-00C244?style=for-the-badge&logo=cash-app&logoColor=white" alt="Cash App" />
</a>

<a href="https://venmo.com/u/Dean1d" target="_blank">
  <img src="https://img.shields.io/badge/Venmo-Dean1d-3D95CE?style=for-the-badge&logo=venmo&logoColor=white" alt="Venmo" />
</a>

## License

[MIT](LICENSE)

