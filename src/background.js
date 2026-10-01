// Content scripts can't open chrome-extension:// pages themselves.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'openCinema' || typeof msg.url !== 'string') return;
  const own = chrome.runtime.getURL('');
  if (!msg.url.startsWith(own) && !msg.url.startsWith('https://')) return;
  chrome.tabs.create({
    url: msg.url,
    index: sender.tab ? sender.tab.index + 1 : undefined,
    openerTabId: sender.tab?.id,
  });
});
