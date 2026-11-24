# homebridge-toyota

[![npm version](https://img.shields.io/npm/v/homebridge-toyota)](https://www.npmjs.com/package/homebridge-toyota)
[![npm weekly downloads](https://img.shields.io/npm/dw/homebridge-toyota)](https://www.npmjs.com/package/homebridge-toyota)

A Homebridge accessory for Toyota Remote Connect. Apple Home gets a door lock control and a momentary remote-start switch. Turning the switch off has no effect on the engine. The lock reads Toyota's last reported status, which can lag behind the vehicle.

## Requirements

- Node.js 22.x, 24.x, or 26.13.1 and later in the 26.x series. Requires Homebridge 1.8 or 2.x.
- A compatible North American Toyota and an active Toyota Remote Connect subscription.
- Version 0.2.0 and later run entirely in Node.js. Homebridge accessory controls were tested with simulated Toyota responses on Node.js 26.13.1. Live testing with the 2026 Sienna is pending.

## Installation and setup

Run these commands on the machine that runs Homebridge. Use a private session directory accessible to the user account running the Homebridge service.

Windows PowerShell:

```powershell
npm.cmd install -g homebridge-toyota
$session = Join-Path $env:LOCALAPPDATA 'homebridge-toyota/session.json'
homebridge-toyota-login.cmd $session
```

macOS or Linux:

```sh
npm install -g homebridge-toyota
homebridge-toyota-login "$HOME/.homebridge-toyota/session.json"
```

Enter your Toyota credentials and, if prompted, the verification code. The command saves a local session file and lists the vehicles on your account. Keep that file private. It contains tokens that can access your Toyota account, and the plugin refreshes them as needed.

If you're upgrading from 0.1.0, keep your existing `sessionFile` and `vin`. Remove the `python` and `clientDirectory` fields from the accessory configuration. If Toyota requires a fresh sign-in, stop Homebridge, run the login command with your existing session path, and then restart Homebridge.


## Configuration

Add one entry to the existing Homebridge `accessories` array. Use the VIN listed by the login command and the absolute session file path from setup. In JSON, use forward slashes for Windows paths or escape each backslash.

```json
{
  "accessory": "Toyota",
  "name": "Sienna",
  "vin": "YOUR_17_CHARACTER_VIN",
  "sessionFile": "/absolute/path/to/session.json"
}
```

Restart Homebridge and open Apple Home. Test the door lock with the Sienna in view. Test remote start outdoors with the vehicle empty. The start switch resets after the request, and vehicle state can be verified in the Toyota app. If Apple Home times out, check the Toyota app before trying again. Keep the remote-start switch out of unattended automations.


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

