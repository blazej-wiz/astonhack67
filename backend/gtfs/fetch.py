from pathlib import Path
import zipfile
import requests

TFWM_GTFS_URL_HTTP = "http://api.tfwm.org.uk/gtfs/tfwm_gtfs.zip"
TFWM_GTFS_URL_HTTPS = "https://api.tfwm.org.uk/gtfs/tfwm_gtfs.zip"

def _looks_like_zip(content: bytes) -> bool:
    # ZIP files start with PK
    return len(content) >= 2 and content[0:2] == b"PK"

def download_gtfs_zip(app_id: str, app_key: str, out_zip_path: str) -> str:
    Path(out_zip_path).parent.mkdir(parents=True, exist_ok=True)

    headers = {
        "User-Agent": "astonhack67-dev/0.1",
        "Accept": "*/*",
    }

    attempts = []

    # 1) HTTP with app_id + app_key
    attempts.append((TFWM_GTFS_URL_HTTP, {"app_id": app_id, "app_key": app_key}, True))

    # 2) HTTP with app_id only (some feeds behave like this)
    attempts.append((TFWM_GTFS_URL_HTTP, {"app_id": app_id}, True))

    # 3) HTTPS with app_id + app_key (but dev-mode verify=False due to cert weirdness)
    attempts.append((TFWM_GTFS_URL_HTTPS, {"app_id": app_id, "app_key": app_key}, False))

    # 4) HTTPS with app_id only (dev-mode verify=False)
    attempts.append((TFWM_GTFS_URL_HTTPS, {"app_id": app_id}, False))

    last_err = None

    for url, params, verify in attempts:
        try:
            r = requests.get(url, params=params, headers=headers, timeout=120, verify=verify)
            # Helpful debug
            print(f"[gtfs] GET {r.url} -> {r.status_code} content-type={r.headers.get('content-type')} len={len(r.content)}")

            if r.status_code == 403:
                last_err = RuntimeError(f"403 Forbidden from {url}")
                continue

            r.raise_for_status()

            if not _looks_like_zip(r.content):
                # You’re getting HTML / text instead of a zip
                snippet = r.text[:200].replace("\n", " ")
                last_err = RuntimeError(f"Response was not a ZIP. content-type={r.headers.get('content-type')} snippet={snippet}")
                continue

            with open(out_zip_path, "wb") as f:
                f.write(r.content)

            return out_zip_path

        except Exception as e:
            last_err = e
            continue

    raise RuntimeError(f"Failed to download GTFS zip after multiple attempts: {last_err}")

def extract_gtfs_zip(zip_path: str, out_dir: str) -> str:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall(out_dir)

    return out_dir