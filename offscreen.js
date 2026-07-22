chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "WRITE_CLIPBOARD") return false;
  try {
    if (typeof message.text !== "string") throw new TypeError("Clipboard value must be text");
    const textarea = document.getElementById("clipboard-text");
    textarea.value = message.text;
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Chrome rejected the clipboard write");
    textarea.value = "";
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
  return false;
});
