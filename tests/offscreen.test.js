const test = require("node:test");
const assert = require("node:assert/strict");

let messageListener;
let copiedText;
const textarea = {
  value: "",
  select() { copiedText = this.value; }
};

global.document = {
  getElementById(id) {
    assert.equal(id, "clipboard-text");
    return textarea;
  },
  execCommand(command) {
    assert.equal(command, "copy");
    return true;
  }
};
global.chrome = {
  runtime: {
    onMessage: { addListener(listener) { messageListener = listener; } }
  }
};

require("../offscreen.js");

function send(message) {
  return new Promise((resolve) => {
    const asynchronous = messageListener(message, {}, resolve);
    assert.equal(asynchronous, false);
  });
}

test("offscreen document writes requested text to the Clipboard API", async () => {
  const response = await send({
    target: "offscreen",
    type: "WRITE_CLIPBOARD",
    text: "https://example.com/current"
  });
  assert.deepEqual(response, { ok: true });
  assert.equal(copiedText, "https://example.com/current");
  assert.equal(textarea.value, "");
});
