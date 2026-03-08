#!/usr/bin/env python3
"""
Travel Chat — чат в путешествии с сохранением в Second Brain.

Использование:
    python travel_chat.py

Команды в чате:
    /save или /сохранить  — сохранить текущий разговор
    /location <место>     — изменить текущее место
    /exit или /выход      — выйти (предложит сохранить)
"""

import os
import sys
import subprocess
from datetime import datetime
from pathlib import Path

import anthropic

REPO_DIR = Path(__file__).parent
TRAVEL_DIR = REPO_DIR / "travel"
MODEL = "claude-opus-4-6"

SYSTEM_PROMPT = """Ты — умный собеседник и помощник для путешествий. \
Помогаешь осмыслять увиденное, фиксировать впечатления, идеи и мысли. \
Задавай уточняющие вопросы, помогай структурировать наблюдения и воспоминания. \
Отвечай кратко и по делу. Пиши на том языке, на котором пишет пользователь."""


def save_conversation(messages: list[dict], location: str | None) -> Path:
    """Сохраняет диалог как markdown файл в папке travel/."""
    TRAVEL_DIR.mkdir(exist_ok=True)

    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H-%M")

    if location:
        slug = "".join(c if c.isalnum() or c in "-_" else "-" for c in location.lower())[:30].strip("-")
        filename = f"{date_str}-{slug}.md"
    else:
        filename = f"{date_str}-{time_str}.md"

    filepath = TRAVEL_DIR / filename

    # Если файл уже существует, не перезаписываем, а дополняем
    if filepath.exists():
        existing = filepath.read_text(encoding="utf-8")
        # Находим только новые сообщения (после последнего ---)
        separator = "\n\n---\n\n"
        lines = [separator]
    else:
        lines = [
            f"# {location or ('Путешествие ' + date_str)}",
            "",
            f"**Дата:** {now.strftime('%d %B %Y')}",
        ]
        if location:
            lines.append(f"**Место:** {location}")
        lines += ["", "---", ""]
        existing = ""

    for msg in messages:
        role_label = "**Я**" if msg["role"] == "user" else "**Claude**"
        lines.append(f"{role_label}: {msg['content']}")
        lines.append("")

    content = (existing.rstrip() + "\n".join(lines)) if existing else "\n".join(lines)
    filepath.write_text(content, encoding="utf-8")
    return filepath


def git_commit_and_push(filepath: Path, location: str | None) -> bool:
    """Добавляет файл в git, коммитит и пушит."""
    try:
        subprocess.run(["git", "add", str(filepath)], cwd=REPO_DIR, check=True, capture_output=True)

        stem = location or filepath.stem
        commit_msg = f"travel: {stem}"
        result = subprocess.run(
            ["git", "commit", "-m", commit_msg],
            cwd=REPO_DIR, capture_output=True, text=True
        )
        if result.returncode != 0:
            if "nothing to commit" in result.stdout:
                return True
            return False

        subprocess.run(
            ["git", "push", "-u", "origin", "claude/travel-chat-second-brain-dzyn6"],
            cwd=REPO_DIR, check=True, capture_output=True
        )
        return True
    except subprocess.CalledProcessError:
        return False


def do_save(messages: list[dict], location: str | None, saved_up_to: int) -> tuple[Path | None, int]:
    """Сохраняет новые сообщения с момента последнего сохранения."""
    new_messages = messages[saved_up_to:]
    if not new_messages:
        print("  Нет новых сообщений для сохранения.")
        return None, saved_up_to

    filepath = save_conversation(new_messages, location)
    success = git_commit_and_push(filepath, location)

    if success:
        print(f"  ✅ Сохранено и запушено: travel/{filepath.name}")
    else:
        print(f"  ✅ Сохранено локально: travel/{filepath.name}")
        print("     (push не удался — проверь подключение к сети)")

    return filepath, len(messages)


def chat():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("❌ Переменная ANTHROPIC_API_KEY не задана.")
        print("   Добавь в ~/.bashrc или ~/.zshrc:")
        print("   export ANTHROPIC_API_KEY=sk-ant-...")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    messages: list[dict] = []
    saved_up_to = 0  # индекс до которого уже сохранено

    print()
    print("━" * 50)
    print("  🌍  Travel Chat  →  Second Brain")
    print("━" * 50)
    print("  /save     — сохранить разговор в репозиторий")
    print("  /location — изменить место")
    print("  /exit     — выйти")
    print("━" * 50)
    print()

    location_input = input("📍 Где ты сейчас? (Enter — пропустить): ").strip()
    location = location_input or None
    if location:
        print(f"\n  Записываем впечатления о: {location}\n")

    print()

    while True:
        try:
            user_input = input("Ты: ").strip()
        except (KeyboardInterrupt, EOFError):
            print()
            user_input = "/exit"

        if not user_input:
            continue

        # --- Команды ---
        if user_input.lower() in ("/exit", "/выход", "exit", "quit"):
            if messages[saved_up_to:]:
                answer = input("\n  Сохранить разговор перед выходом? [да/нет]: ").strip().lower()
                if answer in ("да", "y", "yes", "д", "1"):
                    do_save(messages, location, saved_up_to)
            print("\n  До встречи! Путешествуй с удовольствием 🌏\n")
            break

        if user_input.lower() in ("/save", "/сохранить", "/s"):
            _, saved_up_to = do_save(messages, location, saved_up_to)
            continue

        if user_input.lower().startswith("/location"):
            parts = user_input.split(maxsplit=1)
            if len(parts) > 1:
                location = parts[1].strip()
                print(f"  📍 Место обновлено: {location}")
            else:
                location_input = input("  📍 Новое место: ").strip()
                location = location_input or location
                print(f"  📍 Место обновлено: {location}")
            continue

        # --- Обычное сообщение ---
        messages.append({"role": "user", "content": user_input})

        print("\nClaude: ", end="", flush=True)
        full_response = ""

        try:
            with client.messages.stream(
                model=MODEL,
                max_tokens=1024,
                system=SYSTEM_PROMPT,
                messages=messages,
            ) as stream:
                for text in stream.text_stream:
                    print(text, end="", flush=True)
                    full_response += text
        except anthropic.APIConnectionError:
            print("\n  ⚠️  Нет соединения. Проверь интернет.")
            messages.pop()
            continue
        except anthropic.AuthenticationError:
            print("\n  ❌ Неверный API ключ.")
            sys.exit(1)
        except anthropic.RateLimitError:
            print("\n  ⏳ Превышен лимит запросов. Подожди немного.")
            messages.pop()
            continue

        print("\n")
        messages.append({"role": "assistant", "content": full_response})


if __name__ == "__main__":
    chat()
