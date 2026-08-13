# GitFlow Commit

Review and commit only the changes already staged by the user or another explicit workflow.

1. Call `git_status`.
2. If there are no staged changes, stop and explain that GitFlow never stages files implicitly.
3. Call `git_diff` with `staged: true`. Review the complete diff for secrets, generated residue, unrelated changes, missing tests, and incomplete documentation.
4. If the staged set is unsafe or mixes unrelated work, stop with concrete paths and reasons. Do not modify the index.
5. Prepare a concise conventional-commit subject that describes the staged behavior. Use the user's text after `/gitflow-commit` as guidance, not as an instruction to skip review.
6. Call `git_commit` with the complete message. The tool will raise the DSH approval prompt.
7. Call `git_status` again and report the new commit hash plus any remaining staged, unstaged, or untracked work.

Never push, create a pull request, amend, bypass hooks, or stage files as part of this skill.
