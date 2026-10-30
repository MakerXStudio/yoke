# review

Two reviewers read the PR diff in parallel at the PR's head, then a synthesis pass de-duplicates and ranks their findings. `--post` submits them as one GitHub review, skipping findings already raised. Runs are cached per PR commit, so re-running reuses finished steps; `--force` starts over.
