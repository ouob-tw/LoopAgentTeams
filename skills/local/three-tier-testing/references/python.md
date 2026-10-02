# Python 測試設定（pytest）

## 目錄結構

以下相對於**後端根目錄**（單體專案為專案根，前後端分離為 `<backend>/`）：

```
tests/
  unit/
    __init__.py          ← 選用；只有 package-relative import 需要
    conftest.py          ← 單元測試共用 fixture（無 DB）
  integration/
    __init__.py          ← 選用
    conftest.py          ← DB engine、自動標記、環境載入
  e2e/                   ← 可選；前後端分離時改放 <frontend>/tests/e2e/
    conftest.py
  qa_e2e/                ← 可選；驗收測試（見 SKILL.md），規則同 e2e
    conftest.py
```

pytest 會依目錄層級載入 `conftest.py`，不需要用 `__init__.py` 限制 hook 範圍。只有測試使用 package-relative import 或專案慣例要求 package 時才加入 `__init__.py`。

## pyproject.toml

```toml
[tool.pytest.ini_options]
testpaths = ["tests/unit"]
markers = [
    "integration: requires services (DB, cache)",
    "e2e: requires full stack with real external keys",
    "qa_e2e: acceptance tests from spec QA checklist",
]
```

`testpaths = ["tests/unit"]` 是核心設定。若改成 `tests/` 或包含 `tests/integration`，裸跑 `pytest` 就會執行整合測試，破壞層級隔離。

## 自動標記 conftest.py

每一層的 `conftest.py` 自動套用對應標記，測試檔案不需要手動加 `@pytest.mark.integration`：

```python
# tests/integration/conftest.py
import pytest
from pathlib import Path

INTEGRATION_DIR = Path(__file__).parent

def pytest_collection_modifyitems(items):
    for item in items:
        if INTEGRATION_DIR in item.path.parents:
            item.add_marker(pytest.mark.integration)
```

`tests/e2e/conftest.py` 同理，改用 `pytest.mark.e2e`；`tests/qa_e2e/conftest.py` 用 `pytest.mark.qa_e2e`。

## 環境設定

檔名與 Compose 規則見 SKILL.md「Compose 與 .env 檔案」。單元與整合測試不讀任何 env 檔，也不能讓應用程式自己載入 `.env`。

**Host（預設）：** 不建立 `.env.test`。在 `tests/integration/conftest.py` 頂層（fixture 之前）用 `os.environ[...] = ...` 寫入本機測試 DB 的值（遠端測試 DB 需要密鑰時，改由執行時的 `TEST_*` 環境變數提供）。這可保證早於該目錄的 test module import。若 root conftest、pytest plugin 或應用 bootstrap 更早 import 設定模組，必須把設定移到更早的測試入口；不要宣稱 integration conftest 一定早於所有 import。若應用 bootstrap 會載入 `.env`，測試入口必須停用該載入。

**Docker：** 需要容器時建立 `compose.integration.yml`，值直接寫入；host 上的測試程式需要連入時才 publish 非預設 host port（如 Postgres 用 5433）。整合測試的 conftest 以 session scope autouse fixture 啟動／關閉容器，`-f`、`-p` 照 SKILL.md 的規則帶入。

**E2E：** 若使用 `.env.e2e`，在 `tests/e2e/conftest.py`（驗收測試為 `tests/qa_e2e/conftest.py`）頂層呼叫 `load_dotenv(".env.e2e")`，必須早於應用設定被 import；不載入 `.env`。保留預設 `override=False`，CI 已注入的變數優先；CI 全部注入時不載入檔案。

## 執行指令

前後端分離時，後端指令請先 `cd <backend>` 再執行（`pyproject.toml` 在 `<backend>/`）：

```bash
# 只跑單元測試（預設）
uv run pytest

# 只跑整合測試
uv run pytest tests/integration -m integration

# 單元 + 整合測試
uv run pytest tests/unit tests/integration

# E2E（Python）
uv run pytest tests/e2e -m e2e

# 驗收測試
uv run pytest tests/qa_e2e -m qa_e2e
```

## 驗證迴圈

遷移後反覆執行，直到兩者都正確：

```bash
# 必須只收集單元測試（無 DB fixture、無 integration 標記）
uv run pytest --collect-only

# 必須只收集整合測試（全部標記為 integration）
uv run pytest tests/integration -m integration --collect-only
```

不符合預期時檢查：檔案歸屬、conftest 作用域、自動標記與環境載入順序。
