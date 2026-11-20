# Third-party notices

Tavi includes interface and screen-relay code adapted from Bot HQ. Copyright (c) 2026 Nick Vasilescu. It uses the MIT licence below. Original Bot HQ artwork is not included. Lucide and Feather attribution is retained below. Source files also keep their attribution comments.

## Bot HQ licence

MIT License

Copyright (c) 2026 Nick Vasilescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lucide

Lucide icons are used through lucide-react, under ISC. Some icons come from Feather under MIT.

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.


Some Lucide icons are derived from [Feather](https://feathericons.com). Those are under the MIT License:


Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.




## Components installed separately

The package lock files record the exact versions and licence labels. Packages are installed by each user; their original licence files and notices must remain with them. A built installer must also carry its bundled dependency notices. This list does not relicense third-party code as Tavi code.

| Component | Licence or terms |
|---|---|
| Hermes Agent, pinned by box/install-hermes.sh | Separate upstream program; retain its upstream licence and notices with its installation. It is not copied into this source release. |
| Claude Agent SDK | Provider terms; lock file says SEE LICENSE IN README.md. Not covered by the Tavi MIT licence. |
| Playwright and its MCP server | Apache-2.0 |
| TypeScript | Apache-2.0 |
| dotenv | BSD-2-Clause |
| web-push and noVNC | MPL-2.0; preserve file notices and make covered source available when distributing built copies. |
| ws, Zod and tsx | MIT |
| React, React DOM, React Markdown, remark-gfm, Zustand and three.js | MIT |
| Vite and its React plugin | MIT |
| Electron and electron-builder | MIT; Electron also includes Chromium and other component notices. |
| Geist and Geist Mono | SIL Open Font License 1.1; see ui/src/shared/fonts/LICENSES.md and retain the font packages’ licence files when bundling. |
| Lucide React | ISC, with some Feather-derived icons under MIT, reproduced above. |

Python requirements include PyMuPDF, python-docx, openpyxl, Pillow, pillow-heif, lxml, et_xmlfile and typing_extensions. PyMuPDF is available under AGPL or commercial terms; installing or distributing it requires reviewing those terms for the intended use. These separately installed programs are not covered by the Tavi licence. Blender, Ubuntu, Chrome for Testing, Xvnc, Openbox and optional desktop applications retain their own licences; installers must keep their original notices. No browser binaries, Python packages, Linux image, books or model-provider credentials are copied by this source exporter.

## Published numerical sources

The calculators retain source addresses and the attribution required by the data they use. In src/shared/calc/ncc.ts the retained line is: © Commonwealth of Australia and the States and Territories 2022, published by the Australian Building Codes Board (CC BY-ND 4.0). Only numerical facts and clause identifiers are used there. No Standards Australia document is supplied. User-supplied books and documents remain the user’s responsibility and are excluded from this edition.

## Release review

These notices are taken from the working third-party file, source attribution comments and package lock metadata, without contacting outside services. Review the licence files of dependencies when assembling a binary distribution; this source notice is not a substitute for those files.
