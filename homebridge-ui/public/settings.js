(() => {
  const ui = window.homebridge;
  const field = (id) => document.getElementById(id);
  const form = field('settings-form');
  const loginForm = field('login-form');
  const codeForm = field('code-form');
  let signedInVehicles;

  function showStatus(message) {
    field('status').textContent = message;
  }

  function showVehicles({ vehicles }) {
    signedInVehicles = vehicles;
    field('vehicles').replaceChildren(...vehicles.map(({ vin, modelName, modelYear }) => {
      const option = document.createElement('option');
      option.value = vin;
      option.label = [modelYear, modelName].filter(Boolean).join(' ');
      return option;
    }));
    if (!vehicles.some(({ vin }) => vin === field('vin').value)) {
      field('vin').value = vehicles.length === 1 ? vehicles[0].vin : '';
    }
    codeForm.hidden = true;
    loginForm.hidden = false;
    showStatus('Signed in. Select your vehicle and save Toyota settings.');
  }

  function handleSubmit(element, action) {
    element.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = element.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        showStatus(error?.message || 'Toyota setup failed.');
      } finally {
        button.disabled = false;
      }
    });
  }

  handleSubmit(loginForm, async () => {
    const password = field('password').value;
    field('password').value = '';
    showStatus('Signing in to Toyota…');
    const result = await ui.request('/login', { username: field('email').value, password });
    if (!result.needsCode) return showVehicles(result);
    loginForm.hidden = true;
    codeForm.hidden = false;
    field('code').focus();
    showStatus('Enter the verification code from Toyota.');
  });

  handleSubmit(codeForm, async () => {
    const code = field('code').value;
    field('code').value = '';
    try {
      showVehicles(await ui.request('/verify', { code }));
    } finally {
      codeForm.hidden = true;
      loginForm.hidden = false;
    }
  });

  handleSubmit(form, async () => {
    const vin = field('vin').value.trim().toUpperCase();
    const name = field('name').value.trim();
    if (!name) throw new Error('Enter an accessory name.');
    if (signedInVehicles && !signedInVehicles.some((vehicle) => vehicle.vin === vin)) {
      throw new Error('Select a vehicle from your Toyota account.');
    }
    const blocks = await ui.getPluginConfig();
    const index = blocks.findIndex((item) => item.accessory === 'Toyota');
    const config = {
      ...blocks[index],
      accessory: 'Toyota',
      name,
      vin,
      showDoorLock: field('door-lock').checked,
      showRemoteStart: field('remote-start').checked,
    };
    if (signedInVehicles) delete config.sessionFile;
    if (index < 0) blocks.push(config);
    else blocks[index] = config;
    await ui.updatePluginConfig(blocks);
    await ui.savePluginConfig();
    showStatus('Settings saved. Restart Homebridge to apply them.');
  });

  (async () => {
    const blocks = await ui.getPluginConfig();
    const config = blocks.find((item) => item.accessory === 'Toyota') ?? {};
    field('name').value = config.name ?? 'Sienna';
    field('vin').value = config.vin ?? '';
    field('door-lock').checked = config.showDoorLock !== false;
    field('remote-start').checked = config.showRemoteStart !== false;
    form.querySelector('button[type=submit]').disabled = false;
  })().catch(() => showStatus('Could not load Toyota settings.'));
})();
