(() => {
  const ui = window.homebridge;
  const field = (id) => document.getElementById(id);
  const form = field('settings-form');
  const loginForm = field('login-form');
  const codeForm = field('code-form');
  const cars = field('cars');
  // [config key, label, shown by default]
  const options = [
    ['showDoorLock', 'Door lock and unlock', true],
    ['showRemoteStart', 'Remote start', true],
    ['showOpenings', 'Door, window, hatch, hood and moonroof sensors', true],
    ['showHatch', 'Hatch lock and unlock', false],
    ['showHazards', 'Flash hazards', false],
    ['showHorn', 'Sound horn', false],
    ['showBuzzer', 'Find vehicle (buzzer)', false],
    ['showCloseWindows', 'Close windows', false],
  ];
  let signedInVehicles;

  function showStatus(message) {
    field('status').textContent = message;
  }

  // Each card keeps its original config block so unknown keys (sessionFile, _bridge) survive a save.
  function addCar(config = {}) {
    const card = field('car-template').content.firstElementChild.cloneNode(true);
    card.original = config;
    card.querySelector('[data-field=name]').value = config.name ?? '';
    card.querySelector('[data-field=vin]').value = config.vin ?? '';
    card.querySelector('[data-options]').replaceChildren(...options.map(([key, label, shown]) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'form-check';
      const input = document.createElement('input');
      input.className = 'form-check-input';
      input.type = 'checkbox';
      input.dataset.option = key;
      input.checked = shown ? config[key] !== false : config[key] === true;
      const text = document.createElement('span');
      text.className = 'form-check-label';
      text.textContent = label;
      wrapper.append(input, ' ', text);
      return wrapper;
    }));
    card.querySelector('[data-remove]').addEventListener('click', () => card.remove());
    cars.append(card);
  }

  function showVehicles({ vehicles }) {
    signedInVehicles = vehicles;
    field('vehicles').replaceChildren(...vehicles.map(({ vin, modelName, modelYear }) => {
      const option = document.createElement('option');
      option.value = vin;
      option.label = [modelYear, modelName].filter(Boolean).join(' ');
      return option;
    }));
    const cards = [...cars.children];
    const configured = new Set(cards.map((card) => card.querySelector('[data-field=vin]').value.trim().toUpperCase()));
    for (const vehicle of vehicles.filter(({ vin }) => !configured.has(vin))) {
      // Fill an empty card first, then add one card per remaining account vehicle.
      const empty = cards.find((card) => !card.querySelector('[data-field=vin]').value.trim());
      if (empty) {
        cards.splice(cards.indexOf(empty), 1);
        empty.querySelector('[data-field=vin]').value = vehicle.vin;
      } else {
        addCar({ name: vehicle.modelName ?? '', vin: vehicle.vin });
      }
    }
    codeForm.hidden = true;
    loginForm.hidden = false;
    showStatus('Signed in. Check each vehicle and save Toyota settings.');
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

  field('add-car').addEventListener('click', () => addCar());

  handleSubmit(form, async () => {
    const configs = [...cars.children].map((card) => {
      const name = card.querySelector('[data-field=name]').value.trim();
      const vin = card.querySelector('[data-field=vin]').value.trim().toUpperCase();
      if (!name) throw new Error('Enter a name for each vehicle.');
      if (signedInVehicles && !signedInVehicles.some((vehicle) => vehicle.vin === vin)) {
        throw new Error(`Select a vehicle from your Toyota account for ${name}.`);
      }
      const config = { ...card.original, accessory: 'Toyota', name, vin };
      for (const input of card.querySelectorAll('[data-option]')) config[input.dataset.option] = input.checked;
      // Homebridge derives the HomeKit identity from the name, so keep the old one on rename.
      if (card.original.name && card.original.name !== name && !card.original.uuid_base) {
        config.uuid_base = card.original.name;
      }
      if (signedInVehicles) delete config.sessionFile;
      return config;
    });
    if (!configs.length) throw new Error('Add at least one vehicle.');
    for (const key of ['name', 'vin']) {
      const values = configs.map((config) => config[key]);
      if (new Set(values).size !== values.length) throw new Error(`Each vehicle needs its own ${key === 'vin' ? 'VIN' : 'name'}.`);
    }
    const blocks = await ui.getPluginConfig();
    await ui.updatePluginConfig([...blocks.filter((item) => item.accessory !== 'Toyota'), ...configs]);
    await ui.savePluginConfig();
    showStatus('Settings saved. Restart Homebridge to apply them.');
  });

  (async () => {
    const blocks = (await ui.getPluginConfig()).filter((item) => item.accessory === 'Toyota');
    if (blocks.length) blocks.forEach((config) => addCar(config));
    else addCar({ name: 'Sienna' });
    form.querySelector('button[type=submit]').disabled = false;
  })().catch(() => showStatus('Could not load Toyota settings.'));
})();
