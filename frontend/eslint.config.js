import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // dist 为构建产物；bindings.ts 由 tauri-specta 自动生成，均不参与 lint
  globalIgnores(['dist', 'src/ipc/bindings.ts']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // 终端/协议需处理 ANSI 等控制字符，正则中出现控制字符是本质需求
      'no-control-regex': 'off',
      // 禁止 Tauri / 浏览器原生确认与提示框（文件 open/save 除外）
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tauri-apps/plugin-dialog',
              importNames: ['confirm', 'message', 'ask'],
              message:
                '禁止使用 Tauri 原生 confirm/message/ask。请用 appConfirm / appAlert / appPrompt；文件选择请 import open 或 save。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'confirm',
          message: '请使用 appConfirm()，勿使用 window.confirm。',
        },
        {
          name: 'alert',
          message: '请使用 appAlert()，勿使用 window.alert。',
        },
        {
          name: 'prompt',
          message: '请使用 appPrompt() 或 quickInput()，勿使用 window.prompt。',
        },
      ],
      // 下划线前缀表示有意忽略的变量/参数
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // react-hooks v7 新增的实验性最佳实践规则：保留为提示，不阻断既有合理用法
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      // 组件文件附带导出常量很常见，HMR 提示降为 warning
      'react-refresh/only-export-components': 'warn',
    },
  },
])
