# Данные и конфиденциальность / Privacy

ScriptCraft Studio работает на вашем компьютере. У студии нет своего сервера, учётных записей и телеметрии: она не собирает статистику и ничего не отправляет разработчикам.

## Что остаётся на компьютере

- Проекты (`projects\`), ключи (`.env`), настройки (`settings.json`), журналы (`logs\`) — в папке студии.
- Резервные копии — `Документы\ScriptCraft Studio Backups` (можно выключить или перенести).
- Предпочтения интерфейса (тема, язык, горячие клавиши) — в хранилище окна студии.

## Что и куда уходит по сети — только когда вы этим пользуетесь

| Когда | Куда | Что |
|---|---|---|
| Вопрос ИИ-помощнику или работа агента | выбранная нейросеть: Google Gemini, ваш сервер (OpenAI-совместимый), или локальная Ollama | ваш вопрос, история диалога и — если выбран контекст «Файл»/«Проект» — содержимое файлов проекта, вложенные картинки; файлы вне проекта, которые агент читает с вашего разрешения (студия спрашивает каждый раз) |
| Проверка обновлений (если указан репозиторий) | GitHub (`api.github.com`) | обычный запрос списка релизов, без данных о вас |
| Установка обновления | GitHub | скачивание установщика |
| Установка пакетов | PyPI (`pip`), npm, winget | имена пакетов |
| Публикация на GitHub / `git push` | GitHub или ваш удалённый репозиторий | файлы проекта, которые вы коммитите |
| «Создать issue» в отчёте о проблеме | GitHub — открывается в браузере, отправляете вы сами | описание и сведения о системе |
| Только если сервер студии не отвечает: запасной запуск Python в окне | `cdn.jsdelivr.net` | скачивается сам Pyodide (Python для браузера); ваш код не отправляется |
| Экспорт Markdown в HTML (при открытии файла) | `cdn.jsdelivr.net` | стили формул KaTeX для открытого HTML-файла |

**Никогда не отправляются в ИИ:** файл `.env` проекта и студии, параметры запуска (переменные окружения), ключи API. При работе с Ollama всё остаётся на компьютере.

Данные, отправленные в Google Gemini, обрабатываются по правилам Google (условия Gemini API). Для бесплатного ключа Google может использовать запросы для улучшения своих моделей — не отправляйте в бесплатный Gemini секретный код; используйте платный ключ или Ollama.

## Отчёт о проблеме

«Сообщить о проблеме» собирает отчёт локально: версия, система, конец журнала ошибок. Ключи из `.env` и настроек, токены и имя пользователя вырезаются. Отчёт никуда не уходит сам — вы его копируете или сохраняете.

---

## English

ScriptCraft Studio runs on your computer. It has no server of its own, no accounts and no telemetry.

Network traffic happens only when you use a feature: the chosen AI model (your question, the chat history and, with the "File"/"Project" context, the project files, and files outside the project the agent reads after you approve each time — never `.env`, run settings or API keys), GitHub for update checks/downloads and publishing, PyPI/npm/winget for package installs. Data sent to Google Gemini is processed under Google's Gemini API terms; with a free key Google may use requests to improve its models — use a paid key or a local Ollama model for confidential code. Problem reports are built locally with keys, tokens and your user name removed, and are only shared by you.
