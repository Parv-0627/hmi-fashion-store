param([string]$msg = "Store update")

# Store ko live karta hai (GitHub Pages). Sirf repo ki files push hoti hain —
# Downloads se koi file copy NAHI hoti (purani file nayi ko mita sakti thi).

git pull
if(-not (git status --porcelain)){
  Write-Host "Koi change nahi mila - kuch push karne ko nahi hai." -ForegroundColor Yellow
  exit
}
git add .
git commit -m $msg
git push
Write-Host "PUSH HO GAYA! 1-2 minute mein site update ho jayegi." -ForegroundColor Cyan
