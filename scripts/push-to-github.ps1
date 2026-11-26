param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://github\.com/[^/]+/[^/]+(?:\.git)?$')]
    [string]$RepositoryUrl
)

$ErrorActionPreference = 'Stop'

$branch = (git branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) {
    throw 'Run this script from inside the cloned Talent Hub Git repository.'
}
if ($branch -ne 'main') {
    throw "Expected branch 'main', but current branch is '$branch'."
}

$null = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0) {
    git remote set-url origin $RepositoryUrl
} else {
    git remote add origin $RepositoryUrl
}
if ($LASTEXITCODE -ne 0) {
    throw 'Could not configure the GitHub remote.'
}

git push --set-upstream origin main
if ($LASTEXITCODE -ne 0) {
    throw 'Push failed. Check the repository URL, permissions and GitHub authentication, then retry.'
}

Write-Host 'Talent Hub has been pushed to GitHub.' -ForegroundColor Green
