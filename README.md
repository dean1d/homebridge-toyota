# homebridge-toyota

[![npm version](https://img.shields.io/npm/v/homebridge-toyota)](https://www.npmjs.com/package/homebridge-toyota)
[![npm weekly downloads](https://img.shields.io/npm/dw/homebridge-toyota)](https://www.npmjs.com/package/homebridge-toyota)

A Homebridge accessory for Toyota Remote Connect. Apple Home gets a door lock control and a momentary remote-start switch. Turning the switch off has no effect on the engine. The lock reads Toyota's last reported status, which can lag behind the vehicle.

The plugin runs the Toyota North America client from [orienw/ha-toyota-na](https://github.com/orienw/ha-toyota-na). It uses that project's sign-in, vehicle capability checks, and generation-specific remote command routing. The Home Assistant server and HACS are unnecessary. The client is unofficial and Toyota can change its service. Live compatibility with the 2026 Sienna needs to be verified during setup.

## Requirements

Use Node 22 or 24, Homebridge 1.8 or 2.x, Python 3.13, and Git. Install the files and run the commands on the machine that actually runs Homebridge. An active Toyota Remote Connect subscription and a compatible North American Toyota vehicle are required.

## Installation and setup

Run these commands on your Homebridge host. On Windows, use PowerShell.

```powershell
npm.cmd install -g homebridge-toyota
$plugin = Join-Path (npm.cmd root -g) homebridge-toyota
$toyotaHome = Join-Path $env:LOCALAPPDATA 'homebridge-toyota'
New-Item -ItemType Directory -Force $toyotaHome | Out-Null
git clone https://github.com/orienw/ha-toyota-na.git "$toyotaHome/client"
py -3.13 -m venv "$toyotaHome/venv"
$toyotaPython = "$toyotaHome/venv/Scripts/python.exe"
& $toyotaPython -m pip install -r "$plugin/requirements.txt"
$toyotaClient = "$toyotaHome/client/custom_components/toyota_na"
$toyotaSession = "$toyotaHome/session.json"
& $toyotaPython -I "$plugin/toyota.py" $toyotaClient $toyotaSession login
& $toyotaPython -I "$plugin/toyota.py" $toyotaClient $toyotaSession vehicles
```

On macOS, use Terminal.

```sh
npm install -g homebridge-toyota
plugin="$(npm root -g)/homebridge-toyota"
toyota_dir="$HOME/.homebridge-toyota"
mkdir -p "$toyota_dir"
git clone https://github.com/orienw/ha-toyota-na.git "$toyota_dir/client"
python3.13 -m venv "$toyota_dir/venv"
toyota_python="$toyota_dir/venv/bin/python"
"$toyota_python" -m pip install -r "$plugin/requirements.txt"
toyota_client="$toyota_dir/client/custom_components/toyota_na"
toyota_session="$toyota_dir/session.json"
"$toyota_python" -I "$plugin/toyota.py" "$toyota_client" "$toyota_session" login
"$toyota_python" -I "$plugin/toyota.py" "$toyota_client" "$toyota_session" vehicles
```

Enter the Toyota account credentials in the local terminal. If Toyota requests a verification code, enter the code there. The plugin stores the session locally and refreshes it as needed. Keep the session file under a private directory readable and writable by the account that runs Homebridge. If your Homebridge service has a different global npm prefix or runs as another account, use its plugin directory and a private session directory owned by that account.

## Configuration

Add one entry to the existing Homebridge `accessories` array. Use the exact VIN from the `vehicles` command and the absolute paths from setup. In JSON, use forward slashes for Windows paths or escape each backslash.

```json
{
  "accessory": "Toyota",
  "name": "Sienna",
  "vin": "YOUR_17_CHARACTER_VIN",
  "python": "/absolute/path/to/venv/bin/python",
  "clientDirectory": "/absolute/path/to/client/custom_components/toyota_na",
  "sessionFile": "/absolute/path/to/session.json"
}
```

Restart Homebridge and open Apple Home. Test the door lock with the Sienna in view. Test remote start outdoors with the vehicle empty. The start switch resets after the request, and vehicle state can be verified in the Toyota app. If Apple Home times out, check the Toyota app before trying again. Keep the remote-start switch out of unattended automations.

For an expired session, stop the plugin, rerun the setup login command, then restart Homebridge. The upstream client is loaded from the checkout on disk. Keep the same checkout once tested, as newer revisions may change its Python interfaces.

## Support

Use [GitHub Issues](https://github.com/dean1d/homebridge-toyota/issues) for reproducible bugs and feature requests. Include the vehicle model and year, Homebridge and Node.js versions, and the error code. Remove VINs, credentials, verification codes, and session data from anything you share.

## Credits

- [orienw](https://github.com/orienw) and contributors for the [Toyota North America Home Assistant integration](https://github.com/orienw/ha-toyota-na), whose separately installed Toyota client handles sign-in, vehicle discovery, and remote commands.
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

