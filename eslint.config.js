import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The `no-restricted-syntax` block below is a security control, not a style
 * preference.
 *
 * An IFC file is full of attacker-controlled strings — element names,
 * property names, property values — and the app renders them. The bytes
 * themselves are harmless: they are parsed by web-ifc in a worker and never
 * executed. The one way a malicious model could run code is if any of those
 * strings reached the DOM as *markup* instead of text.
 *
 * Today none of them do; every UI path uses `textContent`. That was true by
 * habit rather than by rule, which is a property that quietly stops being
 * true. The rule makes it enforced. Use `textContent`, `createElement` and
 * `replaceChildren` instead — the codebase currently needs no exceptions to
 * this rule, and adding one should be a deliberate, reviewed decision.
 */
const noHtmlSinks = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "AssignmentExpression[left.property.name='innerHTML']",
      message:
        'Assigning innerHTML can turn a malicious IFC string into executable markup. ' +
        'Use textContent, or build nodes with createElement; clear with replaceChildren().',
    },
    {
      selector: "AssignmentExpression[left.property.name='outerHTML']",
      message: 'Assigning outerHTML has the same injection risk as innerHTML.',
    },
    {
      selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
      message: 'insertAdjacentHTML parses markup. Build nodes and use insertAdjacentElement.',
    },
    {
      selector: "CallExpression[callee.property.name='write'][callee.object.name='document']",
      message: 'document.write parses markup and blocks parsing. Build nodes instead.',
    },
  ],
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    rules: noHtmlSinks,
  },
);
