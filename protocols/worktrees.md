# Team11 Worktree Protocol

Setup, reset, teardown, and Windows-specific safety rules for permanent worktrees.

Loaded by the CEO on `/team11 setup`, `/team11 reset pair <N>`, `/team11 reset all`, `/team11 teardown`.

## Permanent Worktrees

Team11 uses **permanent, pre-created worktrees** — created once via `/team11 setup`, reused forever. No create/destroy per task.

```
<project-root>/../<project-name>-pair-1/   # Pair 1's permanent worktree
<project-root>/../<project-name>-pair-2/   # Pair 2's permanent worktree
<project-root>/../<project-name>-pair-3/   # Pair 3's permanent worktree
<project-root>/../<project-name>-pair-4/   # Pair 4's permanent worktree
<project-root>/../<project-name>-pair-5/   # Pair 5's permanent worktree
```

Worktrees are sibling directories to the project root. They share the `.git` object store (zero duplication of history). Only working files + dependencies are per-worktree.

## `/team11 setup` Protocol

One-time setup. Run once per project. Creates worktrees and installs dependencies.

```bash
# For each pair N (1-5):
PROJECT_NAME=$(basename "$PWD")
WORKTREE_PATH="../${PROJECT_NAME}-pair-N"
BRANCH_NAME="team11-pair-N"

# 1. Create worktree on its own branch from main
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" main

# 2. Install dependencies in the worktree
cd "$WORKTREE_PATH"

# Python (if pyproject.toml exists)
if [ -f pyproject.toml ]; then
  uv venv && uv sync
fi

# Node (if package.json exists in frontend/)
if [ -f frontend/package.json ]; then
  cd frontend && pnpm install && cd ..
fi

# 3. Copy environment files (if .worktreeinclude exists)
# .worktreeinclude lists gitignored files to copy into worktrees
# Example: .env, .env.local, frontend/.env.local
if [ -f "../${PROJECT_NAME}/.worktreeinclude" ]; then
  while IFS= read -r file; do
    [ -f "../${PROJECT_NAME}/$file" ] && cp "../${PROJECT_NAME}/$file" "$file"
  done < "../${PROJECT_NAME}/.worktreeinclude"
fi

cd "../${PROJECT_NAME}"
```

Report after setup:
```
TEAM11 SETUP COMPLETE
  Pair 1: ../food-aggro-pair-1/ (branch: team11-pair-1) ✓
  Pair 2: ../food-aggro-pair-2/ (branch: team11-pair-2) ✓
  Pair 3: ../food-aggro-pair-3/ (branch: team11-pair-3) ✓
  Pair 4: ../food-aggro-pair-4/ (branch: team11-pair-4) ✓
  Pair 5: ../food-aggro-pair-5/ (branch: team11-pair-5) ✓

Disk usage: ~X.XGB total
Ready to use: /team11 <task>
```

## Reset Between Tasks

After a pair's work is merged to main, reset its worktree for the next task.

**IMPORTANT: Worktrees can NEVER checkout `main`.** Git does not allow two worktrees on the same branch. The main repo has `main` checked out, so worktrees must stay on their permanent `team11-pair-N` branch.

```bash
cd "$WORKTREE_PATH"
# Stay on permanent branch, sync it to latest main
git fetch origin main
git reset --hard origin/main   # point pair branch to latest main
git clean -fd                  # remove untracked files
```

This resets the pair's permanent branch to match origin/main exactly. The worktree is now identical to main but on its own branch — ready for the next task.

**Why `reset --hard` is safe here:** The user explicitly invoked `/team11 reset`, which constitutes permission for this destructive operation. The pair's work was already merged to main before reset. Any uncommitted changes are intentionally discarded.

This is what `/team11 reset pair <N>` and `/team11 reset all` do.

## `/team11 teardown` Protocol

Removes all permanent worktrees. **Always use `git worktree remove`, NEVER `rm -rf`.**

```bash
# For each pair N (1-5):
git worktree remove "../${PROJECT_NAME}-pair-N" --force
git branch -d "team11-pair-N"
```

## WINDOWS SAFETY — CRITICAL

**NEVER delete a worktree directory with `rm -rf`, `Remove-Item -Recurse`, or any manual file deletion on Windows.**

On NTFS, `pnpm` creates junctions in `node_modules` that point to the global pnpm store. PowerShell 5.1 and MSYS bash `rm -rf` **follow these junctions and delete the target**, which can permanently destroy `C:\Users\<name>\Documents\`, `Downloads\`, etc.

**Safe deletion ONLY via:**
```bash
git worktree remove <path>          # git handles it correctly
cmd.exe /c "rmdir /S /Q <path>"     # Windows rmdir does NOT follow junctions
```

This is enforced in Team11: the `teardown` and `stop` commands always use `git worktree remove`.

**Also on Windows:**
- Enable `core.longpaths=true` in git config to avoid 260-char path limit issues with deep `node_modules`
- If the project is inside OneDrive, worktrees will also be inside OneDrive. With 10 agents writing files rapidly, OneDrive sync may create `.conflict` files or slow I/O. Consider moving worktrees outside OneDrive using a custom path in the setup protocol.
- Set `core.autocrlf=true` or use `.gitattributes` to prevent line-ending mismatches across worktrees.
