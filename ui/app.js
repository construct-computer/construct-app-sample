// / <reference path="./construct.d.ts" />

construct.ready(() => {
  construct.ui.setTitle('Text Tools');

  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const output = /** @type {HTMLDivElement} */ (document.getElementById('output'));

  /**
   * @param {string} tool
   * @param {Record<string, unknown>} [extraArgs]
   * @param {boolean} [skipInput]
   */
  async function run(tool, extraArgs, skipInput) {
    output.classList.remove('error');
    output.textContent = 'Running\u2026';
    try {
      const args = /** @type {Record<string, unknown>} */ (
        skipInput ? { ...(extraArgs ?? {}) } : { text: input.value, ...extraArgs }
      );
      // For tools that use 'value' instead of 'text', copy the input over
      if (!skipInput && tool === 'timestamp' && !('value' in (extraArgs ?? {}))) {
        args.value = input.value;
      }
      const result = await construct.tools.call(tool, args);
      const text = (result?.content ?? [])
        .map((c) => c.text ?? '')
        .join('\n');
      output.textContent = text || '(empty)';
      if (result?.isError) output.classList.add('error');
    } catch (e) {
      const err = /** @type {Error} */ (e);
      output.classList.add('error');
      output.textContent = 'Error: ' + (err.message ?? String(err));
    }
  }

  for (const btn of document.querySelectorAll('button[data-tool]')) {
    btn.addEventListener('click', () => {
      const el = /** @type {HTMLElement} */ (btn);
      const tool = el.dataset.tool;
      const extra = el.dataset.args ? JSON.parse(el.dataset.args) : undefined;
      const skipInput = el.dataset.skipInput !== undefined;
      if (tool) run(tool, extra, skipInput);
    });
  }
});
