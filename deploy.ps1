param([string]$msg = "Store update")

# Downloads se sabse nayi index / admin file uthao
foreach($name in @("index","admin")){
  $file = Get-ChildItem "$HOME\Downloads" -Filter "$name*.html" -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if($file){
    Copy-Item $file.FullName ".\$name.html" -Force
    Write-Host "[OK] $($file.Name) -> $name.html" -ForegroundColor Green
  }
}

git pull

if(-not (git status --porcelain)){
  Write-Host "Koi change nahi mila - kuch push karne ko nahi hai." -ForegroundColor Yellow
  exit
}

git add .
git commit -m $msg
git push
Write-Host "PUSH HO GAYA! 1-2 minute mein site update ho jayegi." -ForegroundColor Cyan
