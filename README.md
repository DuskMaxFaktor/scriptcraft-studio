# ScriptCraft Studio

Среда для скриптов и программ на Python, JavaScript/TypeScript, HTML/CSS, SQL, PowerShell и других языках — с ИИ-помощником, отладчиком, тестами, Git, блокнотами Jupyter и дизассемблером. Работает на вашем компьютере (Windows 10/11).

## Установка

**Установщик** — `ScriptCraftStudio-Setup.exe`:

1. Запустите его. Права администратора не нужны: студия ставится в `%LOCALAPPDATA%\Programs\ScriptCraftStudio`, появляется в меню «Пуск» и в «Установленных приложениях».
2. Node.js и Python 3.14 (с pip, pytest, Ruff, PyInstaller) уже внутри — ставить ничего не нужно.
3. Обновления: «i» в шапке → «Обновления». Проекты, ключи и настройки при обновлении остаются.
4. Удаление: «Параметры Windows → Приложения» или `Uninstall.exe` в папке студии. Студия спросит, удалять ли ваши проекты.

**Портативная версия** — `ScriptCraftStudio-portable.zip`: распакуйте и запустите `ScriptCraftStudio.exe`.

> Windows может показать «Windows защитила ваш компьютер»: программа пока не подписана сертификатом. Нажмите «Подробнее» → «Выполнить в любом случае».

## С чего начать

При первом запуске студия покажет короткий тур. Справка — «?» в шапке (её текст — [public/help/ru.md](public/help/ru.md)).

- `Ctrl+Enter` — запустить, `F5` — отладка, `Ctrl+P` — перейти к файлу, `Ctrl+Shift+F` — поиск по проекту.
- Ключ Gemini: значок чипа в шапке → «Нейросети». Можно подключить локальную модель Ollama.

## Безопасность и данные

- Программы запускаются с вашими правами. Перед кодом, который удаляет папки, меняет реестр, скачивает и запускает файлы и т.п., студия переспрашивает.
- ИИ-агент спрашивает разрешение перед каждым изменением файлов и запуском.
- В нейросеть уходят ваш вопрос и выбранные файлы проекта. Файлы `.env`, параметры запуска и ключи не отправляются никогда. Подробнее — [PRIVACY.md](PRIVACY.md).
- Сама студия ничего не отправляет «домой»: нет телеметрии. В сеть она ходит только к выбранной нейросети, к GitHub (проверка обновлений, если включена; публикация репозитория), к pip/npm/winget, когда вы ставите пакеты.

## Где что лежит

| Что | Где |
|---|---|
| Проекты | `projects\` в папке студии |
| Ключи (Gemini и др.) | `.env` в папке студии |
| Настройки | `settings.json` |
| Журнал ошибок | `logs\errors.log` |
| Резервные копии | `Документы\ScriptCraft Studio Backups` |

---

## Для разработчиков

Требуется Node.js 22+ и Python 3.12+.

```bash
npm install
npm start          # сервер + сборка интерфейса при изменениях → http://localhost:3000
npm run dev        # Vite с горячей перезагрузкой
npm run app        # окно Electron
```

Устройство: интерфейс — React 19 + Vite + Monaco (`src/`), сервер — Express на tsx (`server.ts`, `api/`), окно — Electron (`electron/`), запускалка `ScriptCraftStudio.exe` — C# (`build_exe.ps1`).

### Тесты

```bash
npm test           # API (node:test), ~2 мин
npm run test:ui    # интерфейс (Playwright), ~3 мин
```

Тесты работают во временных папках и не трогают реальные проекты, реестр, GitHub и папку «Документы».

### Сборка релиза

```bash
powershell -ExecutionPolicy Bypass -File make_installer.ps1
powershell -ExecutionPolicy Bypass -File scripts\clean_pc_check.ps1
```

`make_installer.ps1` собирает портативную версию (`make_portable.ps1`: Node.js и Python скачиваются с официальных сайтов со сверкой SHA-256) и установщик `portable\ScriptCraftStudio-Setup.exe` с файлом `.sha256`. `clean_pc_check.ps1` ставит его в папку с кириллицей и пробелами, запускает студию без Python/Node/Git в PATH, прогоняет `tests\smoke` и удаляет.

Для автообновления опубликуйте на GitHub релиз с тегом `vX.Y.Z` и файлами `ScriptCraftStudio-Setup.exe` и `ScriptCraftStudio-Setup.exe.sha256`.

Лицензии сторонних компонентов — [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
