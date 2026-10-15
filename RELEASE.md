# Выпуск версии

Порядок, которым выпускается версия 1CCoder для Windows. Сборка описана в `EXPORT-README.md`;
здесь — что до неё и после.

## 1. Перед сборкой

1. Поднимите версию в `packages/desktop/package.json` (`version`). Автообновление сравнивает её с
   опубликованной в `latest.yml`, поэтому новая версия должна быть больше.
2. Если менялся код плагина агента или навыков — пересоберите плагин
   (`bun ./scripts/build-v8pack-cli.ts` в `packages/desktop`) и закоммитьте
   `resources/1ccoder-plugin.mjs` вместе с изменением.
3. Проверьте `bun typecheck` и тесты.
4. Убедитесь, что рабочая копия чистая: установщик должен соответствовать конкретному коммиту.
5. Проверки окружения, без которых сборка падает: версия Bun равна закреплённой; Node в `PATH`;
   на диске с `TEMP` 10+ ГБ.

## 2. Сборка

Как в `EXPORT-README.md`: `OPENCODE_CHANNEL` (`prod` или `beta`), `NODE_OPTIONS`, `bun run build`,
`electron-builder --win --publish never`. Адреса сервиса берутся из `.env.production` или
переменных окружения.

## 3. Подпись (необязательно)

Без подписи установщик работает, но Windows SmartScreen предупреждает при запуске. Подпись
встроена в сборку: `electron-builder.config.ts` вызывает `script/sign-windows.ps1` для каждого
файла, если задано `ONECCODER_SIGN=1` (или сборка идёт в GitHub Actions). Скрипт подписывает через
Azure Trusted Signing и ждёт переменные:

```
AZURE_TRUSTED_SIGNING_ENDPOINT
AZURE_TRUSTED_SIGNING_ACCOUNT_NAME
AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE
```

плюс учётные данные Azure. С другим сертификатом замените содержимое `sign-windows.ps1`.

## 4. Проверка установщика

В `packages/desktop/dist/win-unpacked/resources` должны быть:

- `1ccoder-plugin.mjs`, `v8pack-cli.mjs`;
- `toolkit/MCP_Toolkit.epf`, `toolkit/LICENSE`, `toolkit/NOTICE.md`, `toolkit/modifications.diff`;
- `templates/` и `vendor/cc-1c-skills/`;
- `app-update.yml` с адресом **вашего** каталога обновлений;
- **не** должно быть `opencode-cli.exe` (он нужен только для канала разработки).

## 5. Публикация

В каталог обновлений (`<сервис>/updates/`, для беты `/updates/beta/`) — так, чтобы он был
доступен по каждому адресу сервиса:

1. `1ccoder-setup-<версия>.exe` и `.exe.blockmap`;
2. **последним** — `latest.yml`. Пока его нет, клиенты не видят новую версию; если выложить его
   раньше установщика, клиент может начать скачивать незагруженный файл.

Перед публикацией сверьте, что в каталоге нет версии новее: откатывать клиентов на старую
автообновление не будет.
