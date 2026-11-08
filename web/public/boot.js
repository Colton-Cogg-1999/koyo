// Runs before first paint so a chosen day or night theme never flashes the other one.
try {
  var mode = JSON.parse(localStorage.getItem('koyo:theme') || '"auto"');
  if (mode === 'day' || mode === 'night') document.documentElement.dataset.theme = mode;
} catch (e) { /* auto follows the system */ }
