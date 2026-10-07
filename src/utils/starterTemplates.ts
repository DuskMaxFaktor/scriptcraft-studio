import { TemplateProject } from '../types.ts';

// Ready-to-run starter projects: each one runs right after it is created (packages are installed
// automatically) and has a README.md with what to do next.

const telegramBot: TemplateProject = {
  id: 'telegram-bot',
  name: 'Telegram bot (aiogram)',
  description: 'A Telegram bot with commands, buttons, dice and tips.',
  category: 'bots',
  icon: '🤖',
  packages: { pip: ['aiogram'] },
  files: [
    {
      name: 'bot.py',
      language: 'python',
      isEntry: true,
      content: `"""Telegram-бот на aiogram 3.

1. Получите токен у @BotFather в Telegram (команда /newbot).
2. Откройте «Параметры запуска» (кнопка рядом с «Запустить») и добавьте BOT_TOKEN = ваш токен.
3. Нажмите «Запустить» и напишите боту /start.
"""
import asyncio
import logging
import random

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandStart
from aiogram.types import KeyboardButton, Message, ReplyKeyboardMarkup

from config import BOT_TOKEN

dp = Dispatcher()

keyboard = ReplyKeyboardMarkup(
    keyboard=[
        [KeyboardButton(text="🎲 Кубик"), KeyboardButton(text="💡 Совет")],
        [KeyboardButton(text="ℹ️ Помощь")],
    ],
    resize_keyboard=True,
)

TIPS = [
    "Пейте воду — мозгу это нравится.",
    "Сделайте перерыв на 5 минут каждый час.",
    "Маленький шаг сегодня лучше идеального плана на завтра.",
    "Пишите код так, будто его будет читать человек, который знает, где вы живёте.",
]


@dp.message(CommandStart())
async def start(message: Message) -> None:
    name = message.from_user.first_name if message.from_user else "друг"
    await message.answer(f"Привет, {name}! Я учебный бот. Выберите кнопку ниже 👇", reply_markup=keyboard)


@dp.message(Command("help"))
@dp.message(F.text == "ℹ️ Помощь")
async def help_command(message: Message) -> None:
    await message.answer(
        "Что я умею:\\n"
        "🎲 Кубик — брошу кубик\\n"
        "💡 Совет — дам случайный совет\\n"
        "Любой другой текст — повторю его задом наперёд."
    )


@dp.message(F.text == "🎲 Кубик")
async def dice(message: Message) -> None:
    await message.answer_dice()


@dp.message(F.text == "💡 Совет")
async def tip(message: Message) -> None:
    await message.answer(random.choice(TIPS))


@dp.message(F.text)
async def echo(message: Message) -> None:
    await message.answer(message.text[::-1])


async def main() -> None:
    if not BOT_TOKEN:
        print("Нет токена: добавьте BOT_TOKEN в «Параметры запуска» (кнопка рядом с «Запустить») и запустите снова.")
        return
    bot = Bot(BOT_TOKEN)
    me = await bot.get_me()
    print(f"Бот @{me.username} запущен. Напишите ему в Telegram. Остановить — кнопка «Стоп».")
    await dp.start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(main())
`,
    },
    {
      name: 'config.py',
      language: 'python',
      content: `import os

# Токен бота от @BotFather берётся из «Параметров запуска» (кнопка рядом с «Запустить»):
# там он хранится отдельно от кода и не попадёт ни в чат с ИИ, ни на GitHub.
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# Telegram-бот

1. Откройте [@BotFather](https://t.me/BotFather), отправьте \`/newbot\` и получите токен.
2. Нажмите **Параметры запуска** (кнопка с ползунками рядом с «Запустить») и добавьте переменную \`BOT_TOKEN\` с вашим токеном.
3. Откройте \`bot.py\` и нажмите **Запустить** — бот работает, пока не нажмёте **Стоп**.

Пакет \`aiogram\` уже установлен в проект (кнопка «Пакеты» в проводнике).

**Что дальше:** добавьте свою команду — скопируйте функцию \`tip\` и поменяйте текст кнопки.
`,
    },
  ],
};

const flaskSite: TemplateProject = {
  id: 'flask-site',
  name: 'Website on Flask',
  description: 'A Python web server: pages, a template and a JSON API.',
  category: 'web',
  icon: '🌐',
  packages: { pip: ['flask'] },
  files: [
    {
      name: 'app.py',
      language: 'python',
      isEntry: true,
      content: `"""Сайт на Flask: страница со списком заметок и JSON API.

Нажмите «Запустить» и откройте http://127.0.0.1:5000 в браузере.
"""
from datetime import datetime

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

notes = [
    {"text": "Привет! Это первая заметка.", "time": "09:00"},
    {"text": "Flask сам подставляет данные в шаблон templates/index.html.", "time": "09:05"},
]


@app.route("/")
def index():
    return render_template("index.html", notes=notes)


@app.get("/api/notes")
def list_notes():
    return jsonify(notes)


@app.post("/api/notes")
def add_note():
    text = (request.get_json(silent=True) or {}).get("text", "").strip()
    if not text:
        return jsonify({"error": "Пустая заметка"}), 400
    note = {"text": text[:500], "time": datetime.now().strftime("%H:%M")}
    notes.append(note)
    return jsonify(note), 201


if __name__ == "__main__":
    print("Сайт запущен: откройте http://127.0.0.1:5000  (остановить — кнопка «Стоп»)")
    app.run(host="127.0.0.1", port=5000)
`,
    },
    {
      name: 'templates/index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Мои заметки</title>
  <link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>
<body>
  <main>
    <h1>📝 Мои заметки</h1>
    <form id="form">
      <input id="text" placeholder="Новая заметка..." autocomplete="off" required>
      <button>Добавить</button>
    </form>
    <ul id="notes">
      {% for note in notes %}
        <li><span>{{ note.text }}</span><time>{{ note.time }}</time></li>
      {% endfor %}
    </ul>
  </main>
  <script>
    const form = document.getElementById('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('text');
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.value }),
      });
      if (!res.ok) return;
      const note = await res.json();
      const li = document.createElement('li');
      li.innerHTML = '<span></span><time></time>';
      li.querySelector('span').textContent = note.text;
      li.querySelector('time').textContent = note.time;
      document.getElementById('notes').append(li);
      input.value = '';
    });
  </script>
</body>
</html>
`,
    },
    {
      name: 'static/style.css',
      language: 'css',
      content: `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #0f172a;
  color: #e2e8f0;
}
main {
  max-width: 560px;
  margin: 48px auto;
  padding: 0 16px;
}
form {
  display: flex;
  gap: 8px;
}
input {
  flex: 1;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #334155;
  background: #1e293b;
  color: inherit;
}
button {
  padding: 10px 16px;
  border: 0;
  border-radius: 8px;
  background: #6366f1;
  color: white;
  cursor: pointer;
}
ul {
  list-style: none;
  padding: 0;
}
li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  margin-top: 8px;
  border-radius: 8px;
  background: #1e293b;
}
time {
  color: #94a3b8;
  font-size: 13px;
}
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# Сайт на Flask

1. Откройте \`app.py\` и нажмите **Запустить**.
2. Откройте в браузере http://127.0.0.1:5000 и добавьте заметку.

- \`app.py\` — сервер: адреса страниц и API (\`/api/notes\`).
- \`templates/index.html\` — шаблон страницы (Jinja: \`{{ ... }}\`, \`{% for %}\`).
- \`static/style.css\` — оформление.

Заметки хранятся в памяти и пропадают при перезапуске. **Что дальше:** сохраните их в файл \`notes.json\`
(модуль \`json\`) — файл появится прямо в проекте.
`,
    },
  ],
};

const pygameGame: TemplateProject = {
  id: 'pygame-game',
  name: 'Game on pygame',
  description: 'A space dodger: arrows to move, score, levels and restart.',
  category: 'games',
  icon: '🎮',
  packages: { pip: ['pygame-ce'] },
  files: [
    {
      name: 'game.py',
      language: 'python',
      isEntry: true,
      content: `"""Космический уклонист на pygame.

Управление: ← → (или A / D) — движение, Пробел — заново, Esc — выход.
Рекорд сохраняется в файл highscore.txt рядом с игрой.
"""
import random
from pathlib import Path

import pygame

WIDTH, HEIGHT = 480, 640
FPS = 60
HIGHSCORE_FILE = Path(__file__).with_name("highscore.txt")


def load_highscore() -> int:
    try:
        return int(HIGHSCORE_FILE.read_text())
    except (OSError, ValueError):
        return 0


class Rock:
    def __init__(self, speed: float):
        self.size = random.randint(18, 46)
        self.x = random.uniform(0, WIDTH - self.size)
        self.y = -self.size
        self.speed = speed * random.uniform(0.8, 1.4)

    @property
    def rect(self) -> pygame.Rect:
        return pygame.Rect(int(self.x), int(self.y), self.size, self.size)

    def update(self) -> None:
        self.y += self.speed

    def draw(self, screen: pygame.Surface) -> None:
        pygame.draw.rect(screen, (148, 163, 184), self.rect, border_radius=8)


def main() -> None:
    pygame.init()
    screen = pygame.display.set_mode((WIDTH, HEIGHT))
    pygame.display.set_caption("Космический уклонист")
    clock = pygame.time.Clock()
    font = pygame.font.SysFont("arial", 24)
    big = pygame.font.SysFont("arial", 44, bold=True)
    stars = [(random.randrange(WIDTH), random.randrange(HEIGHT)) for _ in range(80)]

    player = pygame.Rect(WIDTH // 2 - 20, HEIGHT - 70, 40, 40)
    rocks: list[Rock] = []
    score = 0
    best = load_highscore()
    alive = True
    spawn_timer = 0

    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT or (event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE):
                running = False
            if event.type == pygame.KEYDOWN and event.key == pygame.K_SPACE and not alive:
                rocks.clear()
                score, alive = 0, True
                player.centerx = WIDTH // 2

        level = 1 + score // 500
        if alive:
            keys = pygame.key.get_pressed()
            if keys[pygame.K_LEFT] or keys[pygame.K_a]:
                player.x -= 7
            if keys[pygame.K_RIGHT] or keys[pygame.K_d]:
                player.x += 7
            player.clamp_ip(screen.get_rect())

            spawn_timer -= 1
            if spawn_timer <= 0:
                rocks.append(Rock(speed=3 + level))
                spawn_timer = max(8, 30 - level * 3)
            for rock in rocks:
                rock.update()
            rocks = [r for r in rocks if r.y < HEIGHT]
            score += 1
            if any(player.colliderect(r.rect) for r in rocks):
                alive = False
                if score > best:
                    best = score
                    HIGHSCORE_FILE.write_text(str(best))

        screen.fill((15, 23, 42))
        for x, y in stars:
            pygame.draw.circle(screen, (71, 85, 105), (x, (y + score) % HEIGHT), 1)
        for rock in rocks:
            rock.draw(screen)
        pygame.draw.polygon(
            screen,
            (99, 102, 241),
            [(player.centerx, player.top), (player.left, player.bottom), (player.right, player.bottom)],
        )
        screen.blit(font.render(f"Очки: {score}   Уровень: {level}   Рекорд: {best}", True, (226, 232, 240)), (12, 10))
        if not alive:
            text = big.render("БАБАХ!", True, (248, 113, 113))
            screen.blit(text, text.get_rect(center=(WIDTH // 2, HEIGHT // 2 - 20)))
            hint = font.render("Пробел — сыграть ещё", True, (226, 232, 240))
            screen.blit(hint, hint.get_rect(center=(WIDTH // 2, HEIGHT // 2 + 30)))

        pygame.display.flip()
        clock.tick(FPS)

    pygame.quit()


if __name__ == "__main__":
    main()
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# Игра на pygame

Откройте \`game.py\` и нажмите **Запустить** — откроется окно игры.

- ← → или A / D — движение, Пробел — заново, Esc — выход.
- Рекорд сохраняется в \`highscore.txt\` — файл появится в проекте после первой игры.

Используется \`pygame-ce\` (современная версия pygame; в коде он импортируется как \`import pygame\`).

**Что дальше:** добавьте бонусы (зелёные квадраты дают +100 очков) или жизни.
`,
    },
  ],
};

const multiPageSite: TemplateProject = {
  id: 'landing-site',
  name: 'Multi-page website',
  description: 'HTML/CSS/JS site with a menu, two pages, a theme switch and a form.',
  category: 'web',
  icon: '🖥️',
  files: [
    {
      name: 'index.html',
      language: 'html',
      isEntry: true,
      content: `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Студия «Пиксель»</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <a class="logo" href="index.html">◆ Пиксель</a>
    <nav>
      <a href="index.html" class="active">Главная</a>
      <a href="about.html">О нас</a>
      <button id="theme" title="Сменить тему">🌙</button>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>Делаем сайты, <span>которые нравятся</span></h1>
      <p>Это шаблон многостраничного сайта. Меняйте тексты, цвета и добавляйте свои страницы.</p>
      <a class="btn" href="#contact">Связаться</a>
    </section>
    <section class="cards">
      <article><h3>⚡ Быстро</h3><p>Чистый HTML, CSS и JavaScript — без сборки и библиотек.</p></article>
      <article><h3>📱 Адаптивно</h3><p>Сетка подстраивается под телефон и компьютер.</p></article>
      <article><h3>🎨 Красиво</h3><p>Светлая и тёмная тема, переключение запоминается.</p></article>
    </section>
    <section id="contact" class="contact">
      <h2>Напишите нам</h2>
      <form id="form">
        <input name="name" placeholder="Имя" required>
        <input name="email" type="email" placeholder="E-mail" required>
        <textarea name="message" rows="3" placeholder="Сообщение" required></textarea>
        <button class="btn">Отправить</button>
        <p id="result" role="status"></p>
      </form>
    </section>
  </main>
  <footer>© <span id="year"></span> Студия «Пиксель»</footer>
  <script src="script.js"></script>
</body>
</html>
`,
    },
    {
      name: 'about.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>О нас — Студия «Пиксель»</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header>
    <a class="logo" href="index.html">◆ Пиксель</a>
    <nav>
      <a href="index.html">Главная</a>
      <a href="about.html" class="active">О нас</a>
      <button id="theme" title="Сменить тему">🌙</button>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>О нас</h1>
      <p>Вторая страница сайта. В веб-просмотре студии страницу можно выбрать в списке или просто перейти по ссылке в меню.</p>
    </section>
    <section class="cards">
      <article><h3>2019</h3><p>Основание студии.</p></article>
      <article><h3>120+</h3><p>Запущенных проектов.</p></article>
      <article><h3>24/7</h3><p>Поддержка клиентов.</p></article>
    </section>
  </main>
  <footer>© <span id="year"></span> Студия «Пиксель»</footer>
  <script src="script.js"></script>
</body>
</html>
`,
    },
    {
      name: 'style.css',
      language: 'css',
      content: `:root {
  --bg: #ffffff;
  --fg: #0f172a;
  --muted: #64748b;
  --card: #f1f5f9;
  --accent: #6366f1;
}
:root.dark {
  --bg: #0f172a;
  --fg: #e2e8f0;
  --muted: #94a3b8;
  --card: #1e293b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: var(--bg);
  color: var(--fg);
  transition: background 0.2s, color 0.2s;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  border-bottom: 1px solid var(--card);
}
.logo { font-weight: 800; color: var(--accent); text-decoration: none; }
nav { display: flex; gap: 16px; align-items: center; }
nav a { color: var(--muted); text-decoration: none; }
nav a.active, nav a:hover { color: var(--fg); }
#theme { border: 0; background: var(--card); border-radius: 8px; padding: 6px 10px; cursor: pointer; }
main { max-width: 960px; margin: 0 auto; padding: 0 24px; }
.hero { padding: 64px 0 32px; }
.hero h1 { font-size: clamp(32px, 6vw, 52px); margin: 0 0 12px; }
.hero h1 span { color: var(--accent); }
.hero p { color: var(--muted); max-width: 560px; }
.btn {
  display: inline-block;
  padding: 12px 20px;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: white;
  text-decoration: none;
  cursor: pointer;
}
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; padding: 24px 0; }
.cards article { background: var(--card); border-radius: 14px; padding: 20px; }
.cards p { color: var(--muted); margin-bottom: 0; }
.contact form { display: grid; gap: 10px; max-width: 480px; }
.contact input, .contact textarea {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--card);
  background: var(--card);
  color: var(--fg);
  font: inherit;
}
footer { text-align: center; color: var(--muted); padding: 32px; }
`,
    },
    {
      name: 'script.js',
      language: 'javascript',
      content: `// Тема: запоминается между страницами и перезапусками
const root = document.documentElement;
const themeButton = document.getElementById('theme');
function applyTheme(dark) {
  root.classList.toggle('dark', dark);
  themeButton.textContent = dark ? '☀️' : '🌙';
}
let dark = false;
try {
  dark = localStorage.getItem('theme') === 'dark';
} catch {}
applyTheme(dark);
themeButton.addEventListener('click', () => {
  dark = !dark;
  applyTheme(dark);
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  } catch {}
});

document.getElementById('year').textContent = new Date().getFullYear();

// Форма: здесь можно отправить данные на сервер (fetch); пока просто показываем ответ
const form = document.getElementById('form');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    console.log('Форма отправлена:', data);
    document.getElementById('result').textContent = \`Спасибо, \${data.name}! Мы ответим на \${data.email}.\`;
    form.reset();
  });
}
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# Многостраничный сайт

Откройте вкладку **Веб-просмотр** внизу — сайт уже работает. Правки видны сразу после сохранения.

- \`index.html\`, \`about.html\` — страницы (меню в шапке ведёт между ними).
- \`style.css\` — цвета задаются переменными в \`:root\` (светлая тема) и \`:root.dark\` (тёмная).
- \`script.js\` — переключатель темы и форма. Сообщения \`console.log\` попадают в терминал студии.

**Что дальше:** добавьте страницу \`contacts.html\` и ссылку на неё в меню обеих страниц.
`,
    },
  ],
};

const webScraper: TemplateProject = {
  id: 'web-scraper',
  name: 'Web scraper',
  description: 'Downloads a page, extracts data with BeautifulSoup and saves a CSV.',
  category: 'python',
  icon: '🕷️',
  packages: { pip: ['requests', 'beautifulsoup4'] },
  files: [
    {
      name: 'scraper.py',
      language: 'python',
      isEntry: true,
      content: `"""Парсер сайта: скачивает страницы с цитатами и сохраняет их в quotes.csv.

Сайт quotes.toscrape.com специально сделан для тренировки парсинга.
На других сайтах соблюдайте их правила (robots.txt) и не отправляйте запросы слишком часто.
"""
import csv
import time
from collections import Counter
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

START_URL = "https://quotes.toscrape.com/"
MAX_PAGES = 3


def scrape(url: str, pages: int) -> list[dict]:
    quotes = []
    session = requests.Session()
    session.headers["User-Agent"] = "ScriptCraft-Studio-learning-scraper"
    for page in range(1, pages + 1):
        print(f"Страница {page}: {url}")
        response = session.get(url, timeout=15)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        for block in soup.select("div.quote"):
            quotes.append(
                {
                    "text": block.select_one("span.text").get_text(strip=True),
                    "author": block.select_one("small.author").get_text(strip=True),
                    "tags": ", ".join(tag.get_text() for tag in block.select("a.tag")),
                }
            )
        next_link = soup.select_one("li.next a")
        if not next_link:
            break
        url = urljoin(url, next_link["href"])
        time.sleep(1)  # вежливая пауза между запросами
    return quotes


def main() -> None:
    quotes = scrape(START_URL, MAX_PAGES)
    with open("quotes.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=["text", "author", "tags"])
        writer.writeheader()
        writer.writerows(quotes)
    print(f"\\nСохранено цитат: {len(quotes)} → quotes.csv (файл появился в проекте)")
    print("\\nСамые цитируемые авторы:")
    for author, count in Counter(q["author"] for q in quotes).most_common(5):
        print(f"  {count} × {author}")


if __name__ == "__main__":
    main()
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# Парсер сайтов

Откройте \`scraper.py\` и нажмите **Запустить**: программа скачает 3 страницы с цитатами
и сохранит их в \`quotes.csv\` — файл появится в проводнике проекта (открывается в Excel).

Пакеты \`requests\` и \`beautifulsoup4\` уже установлены в проект.

**Что дальше:** поменяйте \`MAX_PAGES\` или соберите другие данные — откройте страницу в браузере,
нажмите F12 и найдите нужные теги, а потом укажите их в \`soup.select(...)\`.
`,
    },
  ],
};

const expressApi: TemplateProject = {
  id: 'express-api',
  name: 'REST API on Express',
  description: 'Node.js server with CRUD endpoints, validation and a JSON file store.',
  category: 'web',
  icon: '🔌',
  packages: { npm: ['express'] },
  files: [
    {
      name: 'server.js',
      language: 'javascript',
      isEntry: true,
      content: `// REST API на Express: список задач (CRUD). Данные сохраняются в tasks.json рядом с сервером.
// Нажмите «Запустить» и откройте http://127.0.0.1:4000/api/tasks
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = 4000;
const DB_FILE = path.join(__dirname, 'tasks.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return [{ id: 1, title: 'Попробовать API', done: false }];
  }
}
function save(tasks) {
  fs.writeFileSync(DB_FILE, JSON.stringify(tasks, null, 2));
}

let tasks = load();
const app = express();
app.use(express.json());

// Простая страница с подсказкой
app.get('/', (req, res) => {
  res.type('html').send('<h1>API работает</h1><p>Список задач: <a href="/api/tasks">/api/tasks</a></p>');
});

app.get('/api/tasks', (req, res) => res.json(tasks));

app.get('/api/tasks/:id', (req, res) => {
  const task = tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  res.json(task);
});

app.post('/api/tasks', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Нужно поле title' });
  const task = { id: Math.max(0, ...tasks.map((t) => t.id)) + 1, title, done: false };
  tasks.push(task);
  save(tasks);
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = tasks.find((t) => t.id === Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Задача не найдена' });
  if (typeof req.body?.title === 'string') task.title = req.body.title.trim() || task.title;
  if (typeof req.body?.done === 'boolean') task.done = req.body.done;
  save(tasks);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const before = tasks.length;
  tasks = tasks.filter((t) => t.id !== Number(req.params.id));
  if (tasks.length === before) return res.status(404).json({ error: 'Задача не найдена' });
  save(tasks);
  res.status(204).end();
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(\`API запущен: http://127.0.0.1:\${PORT}/api/tasks  (остановить — кнопка «Стоп»)\`);
  console.log('Проверить из второго терминала: запустите test_api.js');
});
`,
    },
    {
      name: 'test_api.js',
      language: 'javascript',
      content: `// Проверка API: запустите, когда server.js уже работает (Ctrl + Shift + Enter запускает открытый файл)
const BASE = 'http://127.0.0.1:4000/api/tasks';

async function main() {
  const created = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Задача из test_api.js' }),
  }).then((r) => r.json());
  console.log('Создана:', created);

  const updated = await fetch(\`\${BASE}/\${created.id}\`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ done: true }),
  }).then((r) => r.json());
  console.log('Выполнена:', updated);

  const all = await fetch(BASE).then((r) => r.json());
  console.log(\`Всего задач: \${all.length}\`);
}

main().catch((err) => console.error('Сервер не отвечает — сначала запустите server.js.', err.message));
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# REST API на Express

1. Откройте \`server.js\` и нажмите **Запустить** — сервер работает на http://127.0.0.1:4000.
2. Откройте \`test_api.js\` и нажмите **Ctrl + Shift + Enter** (запустить открытый файл) — он создаст задачу.

| Метод | Адрес | Что делает |
|---|---|---|
| GET | /api/tasks | список задач |
| GET | /api/tasks/:id | одна задача |
| POST | /api/tasks | создать (\`{"title": "..."}\`) |
| PATCH | /api/tasks/:id | изменить (\`title\`, \`done\`) |
| DELETE | /api/tasks/:id | удалить |

Задачи сохраняются в \`tasks.json\` — файл появится в проекте.
`,
    },
  ],
};

const textQuest: TemplateProject = {
  id: 'text-quest',
  name: 'Text adventure',
  description: 'A console quest with choices, inventory and several endings — no packages needed.',
  category: 'games',
  icon: '🗝️',
  files: [
    {
      name: 'quest.py',
      language: 'python',
      isEntry: true,
      content: `"""Текстовый квест «Заброшенная башня».

Нажмите «Запустить» и вводите номер варианта в поле ввода внизу терминала.
Сюжет — это словарь сцен: добавляйте свои сцены в SCENES.
"""
import random

SCENES = {
    "start": {
        "text": "Вы стоите у подножия заброшенной башни. Дверь приоткрыта, рядом лежит старый фонарь.",
        "choices": [("Взять фонарь и войти", "hall", "фонарь"), ("Обойти башню", "garden", None)],
    },
    "garden": {
        "text": "За башней — заросший сад. В траве блестит ржавый ключ.",
        "choices": [("Подобрать ключ и вернуться к двери", "hall", "ключ"), ("Уйти домой", "end_home", None)],
    },
    "hall": {
        "text": "Внутри темно и пахнет пылью. Наверх ведёт лестница, вниз — дверь в подвал.",
        "choices": [("Подняться по лестнице", "top", None), ("Спуститься в подвал", "cellar", None)],
    },
    "cellar": {
        "text": "В подвале стоит запертый сундук.",
        "choices": [("Открыть сундук", "chest", None), ("Вернуться наверх", "hall", None)],
    },
    "top": {
        "text": "На вершине башни сидит сова и внимательно смотрит на вас.",
        "choices": [("Поговорить с совой", "owl", None), ("Спуститься обратно", "hall", None)],
    },
}


def chest(inventory: set[str]) -> str:
    if "ключ" in inventory:
        print("Ключ подошёл! В сундуке — карта сокровищ. 🗺️")
        return "end_treasure"
    print("Сундук заперт. Нужен ключ...")
    return "cellar"


def owl(inventory: set[str]) -> str:
    if "фонарь" in inventory:
        print("Сова щурится от света фонаря и улетает, роняя золотое перо. ✨")
        inventory.add("перо")
    else:
        print(random.choice(["Сова ухает.", "Сова отворачивается.", "Сова молчит, но явно что-то знает."]))
    return "top"


ACTIONS = {"chest": chest, "owl": owl}
ENDINGS = {
    "end_home": "Вы решили, что приключения — не для вас, и пошли пить чай. Конец. ☕",
    "end_treasure": "С картой в руках вы покидаете башню. Впереди новое приключение! Конец. 🏆",
}


def ask(choices: list) -> int:
    while True:
        answer = input("Ваш выбор: ").strip()
        if answer.isdigit() and 1 <= int(answer) <= len(choices):
            return int(answer) - 1
        print(f"Введите число от 1 до {len(choices)}.")


def main() -> None:
    print("=== Заброшенная башня ===\\n")
    scene, inventory = "start", set()
    while scene not in ENDINGS:
        if scene in ACTIONS:
            scene = ACTIONS[scene](inventory)
            continue
        data = SCENES[scene]
        print("\\n" + data["text"])
        for i, (label, _, _) in enumerate(data["choices"], 1):
            print(f"  {i}. {label}")
        label, scene, item = data["choices"][ask(data["choices"])]
        if item and item not in inventory:
            inventory.add(item)
            print(f"Вы получили: {item}")
    print("\\n" + ENDINGS[scene])
    print("Инвентарь:", ", ".join(sorted(inventory)) or "пусто")


if __name__ == "__main__":
    main()
`,
    },
    {
      name: 'README.md',
      language: 'markdown',
      content: `# Текстовый квест

Откройте \`quest.py\`, нажмите **Запустить** и вводите номера вариантов в поле ввода под терминалом.

Пакеты не нужны — только стандартный Python.

**Что дальше:** добавьте новую сцену в словарь \`SCENES\` и ведущий в неё вариант в одной из старых сцен.
Попробуйте поставить точку останова (клик слева от номера строки) и запустить отладку **F5**,
чтобы посмотреть, как меняются \`scene\` и \`inventory\`.
`,
    },
  ],
};

/** Shown first in the template gallery. */
export const STARTER_TEMPLATES: TemplateProject[] = [telegramBot, flaskSite, pygameGame, multiPageSite, webScraper, expressApi, textQuest];
