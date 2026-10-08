const box = document.getElementById('community');
const saved = document.getElementById('saved');
chrome.runtime.sendMessage({ type: 'getSettings' }, (s) => { if (s) box.checked = s.community; });
box.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'setSettings', community: box.checked }, () => {
    saved.textContent = box.checked ? 'Listo: base comunitaria activada.' : 'Listo: base comunitaria desactivada.';
  });
});
