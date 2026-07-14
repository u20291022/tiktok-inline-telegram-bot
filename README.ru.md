[English version](README.md) · Русская версия

# TikTok Download — inline-бот для Telegram

Бот скачивает видео из TikTok по ссылке и отправляет его прямо в чат через **inline-режим** — не нужно добавлять бота в чат или писать ему в личку.

## Как этим пользоваться

1. В любом чате (личном, группе, канале — где угодно) начните сообщение с `@toksendbot`, а затем вставьте ссылку на TikTok-видео.
2. Появится всплывающая подсказка «Send TikTok video» — нажмите на неё.
3. Через несколько секунд сообщение-заглушка сменится на само видео с описанием и автором.

Поддерживаемые ссылки:
- `vt.tiktok.com/...`
- `vm.tiktok.com/...`
- `tiktok.com/@user/video/...`
- `tiktok.com/t/...`

<p align="center">
  <img src="assets/inline-query-popup.png" width="320" alt="Ввод ссылки в inline-режиме"><br>
  <sub>Наберите <code>@toksendbot &lt;ссылка&gt;</code> в любом чате и нажмите на подсказку</sub>
</p>

<p align="center">
  <img src="assets/video-delivered.jpg" width="320" alt="Готовое видео в чате"><br>
  <sub>Видео приходит в чат вместе с описанием и автором</sub>
</p>

Личные сообщения боту не поддерживаются — при команде `/start` он сразу объясняет это и показывает пример использования.

<p align="center">
  <img src="assets/bot-profile-start.jpg" width="320" alt="Экран приветствия бота"><br>
  <sub>Экран приветствия бота</sub>
</p>

<p align="center">
  <img src="assets/bot-start-reply.png" width="320" alt="Ответ бота на /start"><br>
  <sub>Что отвечает бот на <code>/start</code></sub>
</p>

---

## Как это устроено

- **`src/index.ts`** — точка входа: читает `.env`, создаёт бота и парсер, запускает polling или webhook, корректно завершает работу по `SIGINT`/`SIGTERM`.
- **`src/bot.ts`** — вся логика Telegram: обрабатывает `inline_query` (мгновенно отвечает заглушкой, потому что inline-запросы Telegram обязаны ответить быстро, а парсинг видео занимает секунды) и `chosen_inline_result` (когда пользователь реально нажал на результат — тогда и начинается скачивание). Уже скачанные видео кэшируются в памяти по URL и по id видео, поэтому повторные запросы отвечают мгновенно, переиспользуя `file_id` из Telegram.
- **`src/tiktok.ts`** — парсер TikTok на **Puppeteer** (`puppeteer-extra` + `puppeteer-extra-plugin-stealth`). Обычный `fetch`/`curl` получает 403 от защиты TikTok (Akamai/Slardar фильтрует по TLS/HTTP2-отпечатку и подсовывает JS-челлендж), поэтому страница видео открывается в настоящем headless Chromium. Плагин Stealth скрывает автоматизационные признаки (`navigator.webdriver` и т.п.). Метаданные видео (автор, описание, размеры) берутся из встроенного в HTML JSON (`__UNIVERSAL_DATA_FOR_REHYDRATION__`), а сам файл видео перехватывается из сетевого ответа `video/mp4` во время загрузки страницы. Между запросами добавляются случайные задержки и «прогрев» сессии визитом на главную страницу — чтобы поведение браузера меньше походило на бота.
- **`src/messages.ts`** — все тексты бота на английском и русском языках, выбор языка по `language_code` пользователя из Telegram.

---

## Установка и запуск у себя

### 1. Требования
- Node.js версии из `.nvmrc` (сейчас `v24.18.0`)
- pnpm
- Linux/macOS/Windows с возможностью запустить Chromium (Puppeteer скачивает его сам при установке зависимостей)

### 2. Системные библиотеки для Chromium (только Linux)
Headless Chromium на "голом" Linux (Ubuntu/Debian) требует системные библиотеки, которых обычно нет на минимальных серверах:

```bash
sudo apt-get update && sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
  libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 \
  libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release \
  xdg-utils libu2f-udev libvulkan1
```

Если на сервере нет виртуального дисплея, можно запускать через `xvfb` — в `package.json` уже есть скрипт `pnpm xvfb` (требует пакет `xvfb`: `sudo apt-get install -y xvfb`).

### 3. Установка проекта
```bash
pnpm install        # заодно скачает Chromium для Puppeteer
cp .env.example .env
```

Заполните `.env`:
```
BOT_TOKEN=токен_вашего_бота
BOT_MODE=polling     # или webhook для продакшена за nginx
```

### 4. Создание бота в BotFather
1. Напишите [@BotFather](https://t.me/BotFather) → `/newbot`, задайте имя и username, получите токен — вставьте его в `BOT_TOKEN`.
2. Включите inline-режим: `/setinline` → выберите бота → введите текст-подсказку (например, «Send TikTok video»).
3. **Обязательно** включите `/setinlinefeedback` → выберите бота → **Enabled** — без этого Telegram не присылает боту событие `chosen_inline_result`, и бот не сможет узнать, когда пользователь выбрал результат, чтобы начать скачивание.
4. (по желанию) `/setdescription` и `/setabouttext` для карточки бота.

### 5. Запуск
```bash
pnpm dev      # разработка (tsx watch)
pnpm build && pnpm start   # продакшен
pnpm xvfb     # запуск через виртуальный дисплей, если нужен
```

Для webhook-режима дополнительно укажите в `.env` `WEBHOOK_DOMAIN`, `WEBHOOK_PATH`, `WEBHOOK_PORT` — бот слушает только `127.0.0.1`, наружу его должен проксировать nginx (или аналог) по HTTPS.

---

### Контакты
По вопросам и предложениям: Telegram — [@cline_z](https://t.me/cline_z)
