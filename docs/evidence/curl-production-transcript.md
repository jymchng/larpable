## boot
ready at https://larpable.netlify.app after 6.9s

## binary
{"answered":false,"command":"command -v curl; readlink -f \"$(command -v curl)\"","output":["/usr/bin/curl","/usr/bin/curl"],"lines":4}

## version
{"answered":false,"command":"curl --version 2>&1 | head -2; echo \"RC=$?\"","output":["curl 8.14.1 (aarch64-unknown-linux-gnu) libcurl/8.14.1 OpenSSL/3.5.7 zlib/1.3.1 brotli/1.1.0 zstd/1.5.7 libidn2/2.3.8 libpsl/0.21.2 libssh2/1.11.1 nghttp2/1.64.0 nghttp3/1.8.0 librtmp/2.3 OpenLDAP/2.6.10","Release-Date: 2025-06-04, security patched: 8.14.1-2+deb13u7"],"lines":8}

## https1
{"answered":false,"command":"curl -sS --max-time 30 -o /dev/null -w \"HTTP=%{http_code} time=%{time_total}s\\n\" https://example.com 2>&1; echo \"RC=$?\"","output":["HTTP=200 time=2.847935s","RC=0"],"lines":13}

## https2
{"answered":false,"command":"curl -sS --max-time 30 -o /dev/null -w \"HTTP=%{http_code} time=%{time_total}s\\n\" https://example.com 2>&1; echo \"RC=$?\"","output":["HTTP=200 time=2.847935s","RC=0","__PROBE_DONE_3__","\u001b]0;user@unkernel: /workspace\u0007/workspace ⇒ curl -sS --max-time 30 -o /dev/null -w \"HTTP=%{http_code} time=%{t \rime_total}s\\n\" https://example.com 2>&1; echo \"RC=$?\"; echo \"__PROBE_DONE_\"\"4__ \r\"","HTTP=200 time=2.147341s","RC=0"],"lines":17}

## plainHttp
{"answered":false,"command":"curl -sS --max-time 20 -o /dev/null -w \"HTTP=%{http_code} time=%{time_total}s\\n\" http://example.com 2>&1; echo \"RC=$?\"","output":["HTTP=200 time=0.212945s"],"lines":20}

## body
{"answered":true,"command":"curl -sS --max-time 30 https://example.com | head -c 120; echo; echo \"RC=$?\"","output":["<!doctype html><html lang=en><head><meta charset=utf-8><link rel=icon href=data:,><meta name=viewport content=\"width=dev","RC=0"],"lines":26}

## dns
{"answered":false,"command":"getent hosts example.com; echo \"RC=$?\"","output":["198.18.0.1      example.com"],"lines":28}
