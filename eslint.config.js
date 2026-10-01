import js from '@eslint/js';

// The extension is plain ESM with no build step, so linting is the only
// static check it has. The rules below are deliberately few: each one exists
// because ignoring it has already produced a real bug in this codebase, not
// because a style guide said so.
export default [
  {
    // Vendored ONNX/OCR/pdf.js assets are third-party build output and are
    // staged by scripts/prepare-local-vision-assets.mjs, not authored here.
    ignores: [
      'extension/vendor/**',
      'extension/models/**',
      'dist/**',
      'node_modules/**',
      'references/**',
      'scratch/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['extension/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Extension-page and service-worker globals.
        chrome: 'readonly',
        browser: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        FormData: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        Blob: 'readonly',
        DataTransfer: 'readonly',
        Uint8Array: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        CSS: 'readonly',
        OffscreenCanvas: 'readonly',
        createImageBitmap: 'readonly',
        crypto: 'readonly',
        indexedDB: 'readonly',
        IDBKeyRange: 'readonly',
        performance: 'readonly',
        Image: 'readonly',
        MouseEvent: 'readonly',
        PointerEvent: 'readonly',
        KeyboardEvent: 'readonly',
        InputEvent: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        matchMedia: 'readonly',
        getComputedStyle: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        requestIdleCallback: 'readonly',
        structuredClone: 'readonly',
        // Content scripts run as classic scripts, not modules.
        __privAgentLog: 'readonly'
      }
    },
    rules: {
      // The bug this project actually shipped: `action.value !== undefined`
      // in one file and `if (action.value)` in another meant "absent" was
      // defined two different ways, so a well-formed UPLOAD carrying
      // "value": null was rejected before the vault was ever read -- silently,
      // with no log line. `null: 'ignore'` keeps the deliberate `== null`
      // presence checks legal while forcing every other comparison to be
      // explicit.
      // Unused code in a privacy-critical path is a liability, and an unused
      // binding is often a half-finished rename.
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],

      // A promise with no rejection path turns a handled error into an
      // unhandled rejection that silently kills the MV3 worker.
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'off', // too noisy for this event-driven code

      // Never ship code that can execute a string.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // A shadowed variable in the privacy/redaction path is how the wrong
      // value gets sanitized and sent.
      'no-shadow': 'error',
      'no-func-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',

      // Reaching into another object's prototype is how prototype pollution
      // bypasses a sanitizer.
      'no-proto': 'error',
      'no-prototype-builtins': 'error',

      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-undef': 'error',
      // `const` bindings are hoisted into a temporal dead zone, so reading one
      // before its declaration is a ReferenceError at runtime rather than a
      // compile error. That exact mistake shipped: local-vision.js read
      // `hasLowConfidenceCoverage` 11 lines above its declaration, which threw
      // on every step of the happy path and silently disabled both the local
      // vision model and the remote /vision endpoint. `no-undef` cannot see it
      // (the binding does exist); this rule can.
      'no-use-before-define': ['error', {
        functions: false,
        classes: false,
        variables: true,
        allowNamedExports: true
      }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-const-assign': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-fallthrough': 'error',
      'no-sparse-arrays': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // Every control-character regex in this codebase is a SANITIZER
      // stripping control codes out of page text, filenames or cell values
      // before they are shown or sent. That is precisely what the rule exists
      // to catch being used for, so flagging them is pure noise here.
      'no-control-regex': 'off',
      // navigation.js keeps a denylist of dangerous URL SCHEMES. Naming
      // "javascript:" as a string to reject is the defence, not a violation.
      'no-script-url': 'off',
      // Escaped slashes inside character classes in the secret/sanitizer
      // regexes are intentional for readability.
      'no-useless-escape': 'off'
    }
  },
  {
    // Tests deliberately construct malformed actions and assert on thrown
    // errors, and run under node:test rather than a browser. Give them the
    // Node globals instead of loosening the rules.
    files: ['tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Uint8Array: 'readonly',
        ArrayBuffer: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        chrome: 'readonly',
        globalThis: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': 'off',
      'no-undef': 'error'
    }
  },
  {
    // content.js is one IIFE whose helpers close over module-level singletons
    // that are declared further down (the stability observer, the overlay).
    // Those references resolve at CALL time, so they are not TDZ hazards --
    // only a straight-line read inside a block is. Verified by the linter
    // catching the real one in local-vision.js.
    files: ['extension/content/*.js'],
    rules: {
      'no-use-before-define': ['error', {
        functions: false,
        classes: false,
        variables: false,
        allowNamedExports: true
      }]
    }
  },
  {
    // Build/staging scripts run in Node, not in a browser.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        TextEncoder: 'readonly',
        crypto: 'readonly'
      }
    }
  },
  {
    // Classic (non-module) content scripts are IIFE-wrapped on purpose.
    files: ['extension/content/*.js'],
    languageOptions: {
      sourceType: 'script'
    }
  }
];