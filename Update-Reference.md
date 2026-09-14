# Chat On Steroids CLEAR — Update Reference

更新手順と互換性判断の正本。対象は、公式 Chat On Steroids に TASK BOX 機能を取り付ける **パッチャー管理の独立モジュール版**です。

## 現在地と基本方針

公式アプリのソース一式へ過去の巨大な差分を cherry-pick する方式を、通常の TASK BOX 更新には使用しません。公式配布物の main と companion を検査し、検証済みの小さな接続部分と独立した機能モジュールを組み合わせます。

これは本体の完全無改変ではありません。本体 main には、モジュール読み込み・公式 Clear callback の受け渡し・認証後の専用経路への委譲を追加します。公式 Clear の処理本文は保存完了確認を含め、そのまま使用します。macOS の画面操作、Accessibility、Native Messaging host、Clear ボタンの代行クリックは使用しません。

**分離実装の検証と、稼働中のアプリへの反映は別です。** 2.0.6 で得た旧統合版の実機 PASS を、新しい分離版や 2.0.7 の実機 PASS に流用してはいけません。配布候補の作成はアプリを起動しません。実際の切替・Chrome 拡張再読み込み・必要な実機受け入れは別途記録します。

## バージョンは三つに分ける

| 管理対象 | 正本 | 意味 |
|---|---|---|
| 公式アプリ | 公式 release と、その配布物 | 2.0.6、2.0.7、2.0.8、2.0.9、2.1.11 など。companion の公式版・bridge protocol と一致させる |
| TASK BOX 機能 | `patcher/task-box/feature.json` の `featureVersion` | Project 操作・Clear 連携・不具合修正の版。本体と独立して更新する |
| 接続契約 | 同ファイルの `protocol`、`adapterRevision`、`releases` | TASK BOX protocol、DOM adapter、検証済みの本体・companion の組み合わせ |

現行カタログの対象は **macOS / Apple silicon、2.0.6・2.0.7・2.0.8・2.0.9・2.1.11**。他の OS・CPU・将来版を検証済みと推定しません。機能版は `1.0.8`、TASK BOX protocol は `1`、adapter revision は `5` です。

## ソースの配置

```text
patcher/task-box/
  feature.json                  機能版・公式 artifact / main / companion の照合値
  main-adapter.mjs               公式 main への小さな接続。元の全バイトへ戻せることを検査
  extension-adapter.mjs          公式 companion の認証・document owner 境界を使う接続
  plugin-refresh-adapter.mjs     現行 ChatGPT Plugins UI への fail-closed refresh adapter
  macos-desktop-adapter.mjs      2.0.9 / 2.1.11 の同一検証済み Swift source だけを狭く変換する Desktop 修復
  build-feature.mjs              独立機能の生成。公式アプリ全体をビルドしない
  package.mjs                    check / prepare / apply
  loader.cjs                    公式 Clear callback と既存 receipt 保存先の接続
  runtime/clear-service.ts       二重 Clear 防止・永続 receipt の唯一の実装
  runtime/index.cjs              認証済み経路から呼ばれる TASK BOX 専用 handler
  extension/                    TASK BOX のブラウザ側正本
```

`extension/task-box*.js` と `extension/task-box-setup.html` は開発・既存回帰テスト用の生成物です。直接編集せず、`npm run feature:sync` で再生成します。旧開発統合の `src/main/task-box-clear.ts` は正本モジュールへの再exportに留めます。実際の新版配布は、公式 release にパッチャーが組み合わせた候補から行います。

**native dialog 修正を含む最新の機能ソースを毎回同じ場所から配布します。** 古い `11c0788` レシピなどへ戻して修正を失わないこと。無関係な過去の helper / model-picker 修正を、新版へまとめて持ち込まないこと。

## 通常の更新手順

### 1. 準備

BOX CLEAR、Project 作成・移動、他のアプリ実行が進行中なら更新しません。`reserved` / `deleting` / 成否不明の記録がある場合は、解除せず先に確認します。旧 standalone CLEAR は無効のままにします。

公式 release の対象アーキテクチャの ZIP と SHA-256 を確認します。ダウンロードしたアプリは、まず別の作業フォルダへ展開します。検証前に稼働中の `/Applications` を置換しません。

```sh
npm run patcher:check -- --app "/path/to/verified/Chat On Steroids.app"
```

このコマンドは読み取り専用です。公式 main の完全一致、companion の完全一致、版・接続構造を検査します。成功は「候補を組み立てられる」の意味であり、実機動作成功ではありません。

### 2. 機能を組み立てる

```sh
npm run patcher:prepare -- \
  --app "/path/to/verified/Chat On Steroids.app" \
  --output "/path/to/new-candidate-directory"
```

出力先は新規ディレクトリを指定します。既存出力やアプリ内部、`/Applications` への prepare は拒否します。出力は次のとおりです。

```text
Chat On Steroids.app       署名・ASAR整合性を検査した候補コピー
task-box-package.json     本体基準・機能・候補のhashと、未実機検証の区別
feature/                  独立して生成した機能ペイロード
composed-main.js           公式 main に接続部分だけを追加した内容
```

公式アプリの main 以外の ASAR 内容、native module、署名sidecar等を、無関係なソースビルドで置き換えません。app.asar.unpacked は既存の保存ロジックを使用し、生成した部分木で丸ごと置換しません。通常の配布検証環境では候補を ad-hoc seal / verify します。一方、利用Macに `~/Library/Application Support/chat-on-steroids/macos-code-signing.json` がある場合は、そこに固定したKeychain identityで候補全体を署名し、Designated Requirementがそのcertificate rootへ結びついたことまで検証します。設定済みidentityがKeychainから失われた場合はad-hocへ戻さずfail-closedします。これはApple Developer IDやnotarizationを意味せず、そのMac上でTCC identityを更新間で安定させるためのローカル署名です。

独立版は、照合済み公式 main と companion の元データを、候補内の `Resources/rocaniiru-task-box/original/` に保存します。次回の同一本体版での機能更新も、この元データから再構成します。そこにユーザー情報や秘密情報は保存しません。旧統合版のようにこの元データを持たない改造本体からは推測して作らず、公式配布物を使用します。

公式入力は main・companion だけでなく **本体全体の fingerprint** も対応表と照合します。既に独立版を適用した本体からの同一版更新では、前回の `task-box-package.json` を `--base-descriptor` に指定します。前回の完成候補と現在の本体が全体一致しなければ拒否します。updater は採用済みdescriptorを保持して、この照合に使用します。候補にはパッケージ生成コードと固定依存関係を含む入力fingerprintも記録し、生成処理が変わった後の古い候補をそのまま適用しません。

### 3. 制御された一回の反映

候補確認後に、本体の終了・入替・起動を明示的に行います。ユーザーの許可なしに自動再起動しません。`apply` 自体は終了・起動を行わず、本体が稼働中なら拒否します。

```sh
npm run patcher:apply -- \
  --app "/Applications/Chat On Steroids.app" \
  --candidate "/path/to/new-candidate-directory/Chat On Steroids.app" \
  --descriptor "/path/to/new-candidate-directory/task-box-package.json" \
  --old-clear-disabled
```

インストール先の基準 fingerprint が descriptor と一致している必要があります。2.0.7公式版から作った候補を、2.0.6の本体へ強引に apply しないでください。まず対応する公式版へ切り替えるか、その手順を含む明示的な切替計画を使います。

apply は退避本体を `.Chat On Steroids.task-box-old-<基準hashの先頭12文字>.app` に残します。別週の更新が同じ退避先を上書きしないための名前です。既にその退避先があれば拒否し、勝手に削除しません。

### 4. companion を確認する

本体起動後、companion の配布元・機能metadataを確認してから、Chrome の拡張を一度だけ再読み込みします。必要なChatGPTページも読み込み直し、**ファイルの一致だけでなく、そのページで実行中の adapter を確認**します。以前、この確認不足が再作成失敗の再発につながりました。

既存の機能有効化設定、TASK BOX generation、Clear receipts は維持します。更新のたびに setup を押して pending 状態を隠す、保存領域を空にする、Clear を自動実行する、といった処理は禁止です。

## パッチャーの更新ボタン

既存 updater を独立モジュール方式で構成する場合は、設定の `taskBoxAddon: true` を使用します。レシピは `feature.json` を参照して選択されます。本体の更新のたびに大量の Git 差分を再作成するものではありません。

```sh
node scripts/rocaniiru-install-updater.mjs --task-box-addon
```

この installer は実際の updater 配置・設定・既存daemonを変更します。**ソース検証コマンドではないので、稼働環境への切替時にのみ実行**します。`--adopt-current-patch` とは併用しません。未完了のruntime反映があるときは拒否します。

「Update patch」は対応検査と候補作成までを行い、「Activation required」で止まります。未知版や不一致なら「Not compatible」で止まります。準備した候補と実際の本体が完全一致した後だけ、companion配布を許可します。終了・入替・起動の権限を、通常のstatusポーリングに持たせません。

古い `defaultPatchCommit` への暗黙フォールバックは廃止しています。対応表にない新版を、TASK BOX統合前のextension-onlyパッチで代用してはいけません。

## 新しい公式版を対応表に追加するとき

**Upstream Absorption Review：TASK BOX側と同等の機能が公式へ入った場合は、独自実装を維持する理由を先に再評価し、不要なら削除します。** 公式が担当するworker・復旧・document ownership等を二重実装しません。

1. 公式release/tag/対象ZIP/checksumを取得し、別フォルダで照合する。
2. main の接続箇所、公式Clearの保存完了条件、認証済みbridge、companionのdocument owner契約を比較する。
3. 契約が同じなら、同一機能モジュールで検証する。差分があれば接続部分だけ修正し、機能へ旧本体全体を取り込まない。
4. `feature.json` に検証した artifact / main / companion の照合値を登録する。単に版の文字列だけを書き換えない。
5. 下記検証を実行し、対応表・機能版・本稿を同じ変更で更新する。

将来版に無条件で対応する約束ではありません。互換性が不明なら追加機能を止め、公式アプリそのものの利用を妨げない設計です。

### 高頻度更新向け：次回公式版の最短runbook

CoS本体は短い間隔で更新される前提で扱います。新しい公式版を検知した時点で、**旧版用パッチを推測で流用しません**。`taskBoxAddon` updaterは未知版を`Not compatible`で止める一方、`release-intake/`へread-onlyの互換性receiptを一度だけ保存します。同じversionとbundled companion fingerprintではreceiptを再利用し、15秒maintenanceごとに本体全体を再hashしません。

receiptは対応許可ではなく、次のレビューを始めるための証拠です。保存内容は、app version、architecture、installed bundle fingerprint、公式main hash、companion fingerprint、Bridge protocol、既存main/extension seamの一致状況、2.0.9で導入したMCP修復が「まだ必要／公式側へ吸収済みまたは既適用／shape変更」のどれか、plugin-refresh adapterの現行seamがそのまま適用可能か、ローカルに公式tagがあればmacOS Desktop Swift source hashと2.0.9 sourceとの一致、です。未知版を自動で`feature.json`へ追加したりcandidateを生成・適用したりはしません。

手動で同じintakeを取り直す場合:

```sh
npm run patcher:intake -- \
  --app "/path/to/verified/Chat On Steroids.app" \
  --output "/path/to/release-intake.json"
```

次版対応は、以下の順序だけで進めます。

1. updaterの自動receiptまたは`patcher:intake`結果を読む。`authority: review-required`のままなら未対応版であり、ここで本番patchを動かさない。
2. 公式release/tag、macOS arm64 artifact、公開SHA-256をfresh取得し、downloaded artifactを照合する。intakeのinstalled bundleだけで公開artifact digestを代用しない。
3. `compatibilityEvidence.main`を確認する。`baseSeams:false`または各2.0.9 repair seamが`changed`なら、旧transformを広げずその変更点を読む。`needs-patch`なら現行修復がまだ必要な候補、`absorbed-or-already-patched`なら公式吸収の可能性を先に検証する。
4. `extensionContract.compatibleShape`と`pluginRefresh`三面を確認する。全部が既知shapeでも、それだけで新版をsupport扱いにはしない。document ownership、認証、current ChatGPT Plugins routeをactual sourceで確認する。
5. `localTag.desktopSourceSha256`を確認する。2.0.9と同一sourceならnative pointer修復のcarry-forward候補。sourceが変わっていれば、旧Swift transformをhash条件だけ緩めて通さず、公式側のfocus/click実装を比較する。公式が修復を吸収していればnative patch自体を外す。
6. Upstream Absorption Reviewを終えてから、公開artifact digest・tag commit・main・companion・必要ならDesktop source hashを`feature.json`へ追加する。版文字列だけ追加しない。
7. `patcher:check`、release matrix、TASK BOX/updater tests、typecheck、`git diff --check`を通した後だけcandidateをprepareする。candidate生成とlive acceptanceを同じPASSとして扱わない。
8. live cutoverは**終了1回・置換1回・起動1回**。CoSを終了した後にCoS自身のCore/Desktop MCPへ頼らない。必要なone-shot cutover実行主体は終了前にCoS process treeの外へ確実にdetachし、persistent/repeating launchd jobは使わない。**`launchctl submit` はone-shot primitiveとして扱わない**。2026-09-15にsuccessful exit後もjobが再起動された実機事象があるため、no-respawn lifetimeを事前に証明できる実行主体と、mutation前のconsumed-stage/sentinelを必須とする。
9. 起動後はinstalled candidate fingerprint、固定code-signing Designated Requirement、TASK BOX/Clear durable state、updater adoption、companion reloadを確認する。TCCを推測でresetしない。
10. acceptanceはCore / Desktop / Pluginsの実callとdurable `mcp-activity`、plugin-refresh receipt完了、Screen Recording / Accessibility granted、harmless Desktop click 1回を確認する。acceptance失敗は同じcandidateを再適用する権限ではない。原因を切り分け、必要なら新しいfeature revisionとして前進修正する。

このrunbookの目的は「新版を自動承認すること」ではなく、**新版が来た瞬間に証拠収集を済ませ、差分レビューから開始できること**です。未知版で公式CoS自体は使えても、TASK BOX/addonは検証済みmatrixへ入るまでfail-closedを維持します。

## 検証コマンドと判定

```sh
npm run feature:sync
npm run typecheck
npx vitest run test/task-box-*.test.ts test/rocaniiru-updater.test.ts test/extension-rocaniiru-updater.test.ts
npm run verify
git diff --check
```

配布済み公式アプリの実際のcompiled handlerを使用する、非GUIの追加検証:

```sh
COS_TASK_BOX_RELEASE_TEST_ROOT="/path/to/verified-upstream" \
  npx vitest run test/task-box-modular.test.ts
```

対象フォルダ形式は `<root>/<version>/unpacked/Chat On Steroids.app` で、version は `2.0.6`・`2.0.7`・`2.0.8`・`2.0.9`。このテストは公式handlerの認証境界とClear callbackを、隔離された保存先・依存関数で実行します。Electron本体や稼働中アプリは起動しません。

必須の負例: 未知版／main不一致／認証失敗／古いdocument／重複request／応答喪失／保存失敗／壊れたreceipt／古いpending状態／機能無効化後の削除／曖昧なProject・入力欄。既存のnative dialogと空のTASK BOX再作成の回帰も維持します。

テスト、署名確認、候補生成、実機受け入れを混同しません。既知の環境テスト失敗を除外・緩和して全成功と報告しません。機能変更・反映が必要ない更新に、ユーザーデータ削除を何度も要求する実機テストを加えません。

## 問題が起きたとき

BOX CLEARの再クリック、Clearの再送、別のProject削除をしません。最新の `lastBoxClearOperation` と同じ要求IDの app receipt、`taskBoxCreationGlobal` を確認します。完了が不明な操作は、更新で解除しません。

本体と拡張が不一致なら TASK BOX を使用せず、検証済みの本体・companion の組み合わせへ戻します。退避本体の復元も本体停止下の明示作業です。状態ファイルやChrome storageを過去のバックアップで巻き戻すと二重実行防止を失うため、ペイロードの切り戻しと状態の保持を分けます。

workerの移動が `UI_BUSY` で止まった場合は、まずその会話に開いているメニュー・ダイアログを確認します。新機能の案内など、閉じても作業を失わないと確認できたものだけを閉じます。移動先選択や作成をまだ送っていないことと、workerが応答終了済みであることを確認できた場合は、そのworkerページの一度の再読み込みで通常の自動整理を再確認できます。状態の初期化、無関係なダイアログの自動消去、無制限の再試行で安全停止を迂回しません。

過去の実機検証経緯は [`docs/task-box.md`](docs/task-box.md) を参照してください。本稿は、その履歴を成功で上書きするものではありません。

## 分離版の検証記録 — 2026-09-09

2.0.6／2.0.7の公式macOS arm64 ZIPを取得してSHA-256を照合し、同じ接続コードで候補を構成しました。公式 main への追加は両方とも673バイトです。追加部分を取り除くと、元のmain全体とバイト単位で一致します。Clear callback本文は変更していません。

両版の候補コピーで署名・ASAR整合性・入力の保持を確認しました。2.0.7の分離版候補を基準descriptor付きで再構成し、本体版を変えない機能更新も確認しました。基準descriptorなしの既存addonや、本体のmain／companion以外を改変した入力も拒否されます。

公式配布物のcompiled handlerを含む関連12ファイルは **197/197成功**。型チェックも成功しています。全体の `npm run verify` は **2,944成功・103スキップ・1失敗**で、失敗は以前から記録されているbundled ripgrepのPATH選択テストです。103スキップには通常CIでは配布物の保存先を渡さない3件のrelease-matrixテストが含まれ、それらは上記197件の実行で別途成功しています。独立実行した終了処理のテストは **2/2成功**です。

この検証では稼働中の本体、stable companion、updater設定を更新していません。新しい2.0.7本体を起動した実機受け入れ、Chromeでの分離版有効化、分離版での実際のBOX CLEARは未実施です。候補の `liveAcceptance` は `false` のままです。

## 本番切替記録 — 2.0.7 / 2026-09-09

上記の候補検証後、ユーザー承認を受けて `0717151` の分離版を本番へ反映しました。本体とcompanionは `2.0.7`、TASK BOX機能は `1.0.0`、bridge protocolは `13`、TASK BOX protocolは `1`、adapter revisionは `2` です。開発用repoの本体バージョンをそのまま配布したのではなく、照合済みの公式2.0.7を入力にした候補を使用しています。

初回の2.0.6→2.0.7切替は、旧updaterを一時停止し、稼働本体を通常終了、旧本体を固有名で退避、停止した公式2.0.7を配置、既存の `applyAddon` で同版の検証済み候補を反映、全体照合後に起動、の順で実施しました。未改変の2.0.7を途中で起動せず、切替runnerが要求した本体の終了と起動は各1回です。旧本体・旧companion・旧updater設定の退避を保持し、状態ファイルの巻き戻しはしていません。

updaterは `taskBoxAddon: true`、暗黙の `defaultPatchCommit` は `null` に切り替えました。実際に配置された候補の全体fingerprintが一致してからcompanionを公開し、採用済みdescriptorをupdaterの永続的なprepared領域へ保存しています。Chrome本体は再起動せず、companionだけを1回再読み込みしました。

新しく開いた既存TASK BOXのProject画面で、実行中の2.0.7／機能1.0.0／protocol 13／adapter revision 2、正常なruntime、1件のTASK BOXとreadyのBOX CLEARを確認しました。fresh workerの自動移動は `moveCompleted: true`、同じ会話のProject内カード、移動後の応答 `TASK_BOX_207_ALIVE` まで確認済みです。Project画面のスクリーンショットも照合しました。

更新前から開かれていた実装チャットと旧Projectタブのスクリプト観測はタイムアウトし、それらのページ内コードまで更新済みとは確認していません。進行中のチャットを強制再読み込みせず、新規Projectビューで検証しました。古いタブは使用前に一度再読み込みし、新規ビューで得た実行版確認と混同しないこと。

切替runnerは終了済みで再実行されていませんが、その後の02:45頃（日本時間）に別の終了・起動が1回アプリログに記録されています。当時は起点未特定として記録しましたが、その後ユーザーから、macOSの権限再承認に伴って手動再起動したとの説明がありました。後続の実機検証時も、本体全体は検証済み2.0.7候補と一致しています。

切替前後でClear receiptファイルのhashは一致し、既存3件の完了記録とgeneration 3 / presentを保持しています。この切替ではClear・Project削除・Project再作成を実行していません。**2.0.7分離版の本番切替と自動移動は確認済みですが、同版での破壊的なBOX CLEAR通し実機テストは未実施です。** 2.0.6の実機結果と197件の隔離テストを、その代わりの新しい実機PASSとして扱いません。候補作成時のdescriptorも、後日の実機結果で書き換えません。

## 2.0.8対応 — 2026-09-09

公式 `v2.0.8` のmacOS arm64 ZIPを、release asset digestと同梱SHA256SUMSの両方で照合し、本体全体・main・companionのfingerprintを対応表へ追加しました。Bridge protocolは13、TASK BOX機能は1.0.0、TASK BOX protocolは1、adapter revisionは2のままです。

公式Clear本文と、companionの `call` / `authorizeDocument` / `ownsDocument` / `serializeTab` / `restoreChatgptTab` / `restoreOpenChatgptTabs` は、2.0.7から変更されていません。TASK BOXのruntime、ブラウザ側機能、接続処理のロジックは変更せず、対応カタログとテスト行列だけを拡張しました。公式mainへの追加は引き続き673バイトです。旧helper/model-picker等の独自修正は取り込みません。

2.0.8未登録時の拒否を回帰テストで確認した後、2.0.6・2.0.7・2.0.8の公式配布物を含む関連12ファイル **202/202成功**を確認しました。`npm run verify` は **2,948成功・104スキップ・1失敗**で、失敗は従来と同じbundled ripgrepのPATH選択です。104スキップのうち4件のrelease-matrixテストは、上記202件の実行で別途成功しています。型チェックは成功し、配布候補の署名・ASAR整合性・入力保持も検証済みです。候補作成時点では2.0.8の実機受け入れは未実施です。

この更新の出発点は、既に切替済みの2.0.7です。過去の調査文にある「2.0.6から直接2.0.8へ」という予定を、現物確認なしに実行しません。権限再承認が必要な場合はユーザーがmacOS側で行い、必要な手動再起動を更新記録に分けて残します。パッチャーがTCC設定を変更・リセットしたり、再起動を繰り返して解消しようとしたりしません。

## 本番切替後の受け入れ — 2.0.8 / 2026-09-09

`6eebd3c` の2.0.8対応候補は、制御された切替runnerによって03:28:53〜03:29:00（日本時間）に反映されました。runnerの終了要求・適用・起動要求は各1回で、runnerは終了済みです。ユーザーから2.0.8起動の報告を受けた後、Coreのコマンド実行とDesktopの読み取り接続が復帰し、稼働本体の全体fingerprintが準備済み候補と一致することを再確認しました。この受け入れ継続では本体を再起動していません。

本体とstable配布物は2.0.8でしたが、Chromeに登録済みのcompanionはまだ2.0.7だったため、companionだけを一度再読み込みしました。その後の登録版は2.0.8です。ファイルの一致だけでなく、実装チャットと検証用Projectページで、実行中のappVersion 2.0.8、TASK BOX機能1.0.0、Bridge protocol 13、TASK BOX protocol 1、adapter revision 2、healthy runtimeを確認しました。登録版確認後にupdaterのreload待ちをacknowledgeし、activationRequired / updateAvailable / reloadRequiredはすべてfalseになっています。

fresh workerを1件だけ起動しました。最初の自動移動はChatGPTの「画像生成が大幅に進化」という案内ダイアログによって `UI_BUSY` で安全停止しました。確認した同じ案内内の「閉じる」だけを1回押し、応答終了済みの同じテストworkerページを1回再読み込みした後、本番companionが自動移動を完了しました。手動move、機能コードの変更、検証用runtimeへの差し替え、テストフック、lifecycleや試行回数の直接リセットは使用していません。**これは「案内ダイアログを閉じた後の自動移動成功」であり、初回から無介入で成功したとの記録ではありません。** 最初の失敗観測も保存しています。

移動完了記録の `moveCompleted: true` と、同じworkerのProject内会話カードを照合しました。実画面には `Fresh Worker Validation` がTASK BOX内に表示され、移動後の同じworkerから `TASK_BOX_208_ALIVE` の返答とfinishを会話記録でも確認しました。新しいProjectは作らず、既存TASK BOXを再使用しています。検証時のTASK BOXは1件、BOX CLEARはready、generation 3 / presentのままです。

閲覧検証では、既存Projectへの直リンク表示が「Try again」で止まる観測もありました。同じ検証用タブを再使用し、ChatGPTホームのexact TASK BOX行にある標準Project-home操作から開くと、正常なProjectと実際の会話一覧を確認できました。直リンクの読み込み失敗の原因は確定しておらず、Project消失や再作成の根拠にはしていません。

既存3件のClear完了receiptは、更新前・起動確認後・受け入れ終了時でファイルhashが一致しています。機能有効化設定と過去のcleanup完了記録も保持し、Clear・Project削除・Project再作成は行っていません。旧2.0.7本体の切り戻しコピーも元のfingerprintと一致します。

検証用の一時拡張ファイル10個と診断タブは撤去済みです。終了時に、本体・stable companion・機能fingerprintがそれぞれ検証済み候補／updater構成と一致することを確認しました。**2.0.8への本番反映、状態保持、案内ダイアログを閉じた後の自動移動と移動後応答を確認済みです。2.0.8での破壊的なBOX CLEAR通しテストは再実行していません。** 事前の202件の関連テストや旧版の削除テストを、その代わりの実機PASSとして扱いません。

## TASK BOX 1.0.1 — `INVALID_CREATE_OWNER` 修正 / 2026-09-11

fresh worker の自動移動で、Project作成予約の直前に `INVALID_CREATE_OWNER` で停止する事象を確認しました。失敗した要求の conversation id 自体と Chrome document owner は有効で、旧実装が `reserve-create` 時だけ `MessageSender.url` を独自に `/c/<id>` と再照合していたことが原因でした。ChatGPT のSPA遷移やreload中は `MessageSender.url` が一時的にroot/id-lessになり得る一方、公式 companion は既に `authorizeDocument()` / `ownsDocument()` と `conversationForTab()` / `tabConversations` でcurrent-tab identityを所有しています。

1.0.1では、TASK BOX側のconversation route再実装を削除し、既に認証済みのcurrent documentから `chrome.tabs.get()` でaction-time tabを読み、公式 `conversationForTab()` の結果と要求 conversation id を一致確認してからのみ作成予約します。具体的な別会話URLはregistryより優先されるため、古い `MessageSender.url` を根拠に別会話へ予約することも拒否します。2.0.6・2.0.7・2.0.8でこの公式conversation arbitration契約が同一であることをadapterのfail-closed contractとして固定しています。

回帰テストは、(1) `MessageSender.url` がChatGPT rootでも公式current-tab identityが対象workerなら予約できること、(2) `MessageSender.url` が対象workerの古い値でも実タブが別会話なら拒否すること、の両方向を追加しました。機能版のみ `1.0.1` へ上げ、TASK BOX protocol `1` とadapter revision `2` は変更していません。**この記録時点ではソース／非GUI検証段階であり、稼働中2.0.8への反映・Chrome companion再読み込み・fresh worker実機再確認はまだ行っていません。** 既存の未完了BOX CLEAR lifecycleを更新で初期化したり、再実行したりしません。

## TASK BOX 1.0.2 — native削除確認 / `UI_BUSY` retry 修正 / 2026-09-11

同じ実機記録では、`INVALID_CREATE_OWNER` より前のBOX CLEAR `2c772e6c-aae4-4567-bfd1-83a7bc833ea7` が、app側Clear完了後のProject削除で `DELETE_PROJECT_CONFIRM_NOT_FOUND` に停止していました。content adapterには既にProject作成用の `openProjectDialogs()` があり、ARIA dialogだけでなくnative `dialog[open]` も正しく扱いますが、Project削除確認とmanual-delete観測だけが古い `[role="dialog"]` の独自探索を残していました。失敗時の実DOM snapshot自体は保存されていないため「その実機dialogがnativeだった」とは断定しませんが、この分裂は同じエラーを再現するcode-level defectです。1.0.2では削除確認も同じ `openProjectDialogs()` authorityへ統合し、native delete-confirmの回帰を追加しました。

後続の `UI_BUSY` は、ユーザーがProject UIを操作中なら安全に停止すべき状態です。一方、旧 `schedule()` はcatchが設定した `800 / 1800 / 4000 / 8000 ms` のretry待ちを、`pointerover`・focus・MutationObserverの `schedule(0 / 180)` で短縮できました。実ログでも同じworkerが約0.34秒内に4回 `UI_BUSY` を消費しています。1.0.2ではretryのnot-before時刻を持ち、通常のDOMイベントはその時刻を前倒しできないようにしました。また4本目の `8000 ms` が旧 `MAX_MOVE_ATTEMPTS` のoff-by-oneで到達不能だったため、初回＋4 retryの5試行に修正しています。retry対象は従来どおり、target/createをまだ送っていないdiscovery failureだけです。無制限retryにはしていません。

このDOM adapter変更に伴いadapter revisionを `3` に上げています。既存rev2 runtimeは新しいrev3が注入されたときにhealthy incumbentとして残らず、既存のtakeover境界で停止・置換されます。TASK BOX protocolは `1` のままです。**既存の実機lifecycle `deleting` はこのコード更新だけでは解消しません。過去の未完了削除を「完了」に書き換えたり、同じClearを再送したりすることは禁止したままです。**

## TASK BOX 1.0.3 — 手動削除済みProjectの限定lifecycle recovery / 2026-09-11

上記の実機lifecycleでは、request `2c772e6c-aae4-4567-bfd1-83a7bc833ea7` の公式Clearはapp側durable receiptで完了済みでしたが、browser側はProject削除確認に失敗したため `deleting / clearCompleted:true / generation:14` に残りました。その後、利用者がTASK BOX Projectを手動削除済みであることを明示しています。1.0.3は、この既知状態をstorage resetや過去操作のreplayで隠さず、**exact completed-Clearだけをbrowser lifecycle上でreconcileする専用recovery**を追加します。

recoveryは一般的な `reserved` / `deleting` 解放APIではありません。browser coordinatorが同じrequest/generationの `deleting + kind:clear + clearCompleted:true` とcompleted Clear attempt receiptを確認し、backgroundが保存済みownerを**app receiptのread-only照合だけ**に使って `GET /task-box/clear/status` のexact completedを再確認します。setup pageはextension-originに限定し、利用者が「過去結果を確認した」「TASK BOX Projectを手動削除済み」と明示した場合だけexact request/generationを渡します。照合中にlifecycleが変われば停止します。

成功時はClear、Project削除、Project作成を一切再実行せず、global lifecycleだけをgeneration+1の `open` へ進めます。旧Clear attemptとapp receiptは削除せず、manual recovery receiptを追加して同じrecovery自体もidempotentにします。次のfresh workerが通常のreserve/create経路で新しい空TASK BOXを作成するまで、Projectは存在しない状態が正しいです。`POST /task-box/clear`、Project delete DOM action、自動recreateはこのrecovery経路にありません。

この変更はcontent DOM adapter `task-box.js` を変更しないため、機能版のみ `1.0.3` へ上げ、TASK BOX protocol `1` / adapter revision `3` は維持します。**この記録時点ではソース実装と非GUI検証の段階であり、稼働中2.0.8への反映・既存generation 14の実機recovery・fresh workerによる再作成確認はまだ行っていません。** controlled activation前に既存browser/app receiptを保持し、同じClearやProject削除を再送してはいけません。

1.0.3のfocused recovery/adapter検証は **45/45成功**、TASK BOX・updater隣接検証は **105成功・4スキップ**、typecheck・`git diff --check`・production buildは成功しました。full `npm run verify` は **2,963成功・104スキップ・1失敗**で、唯一の失敗は従来からのbundled ripgrep PATH選択（期待する `resources/rg/rg` ではなく `/opt/homebrew/bin/rg`）です。verifyがそこで終了するため `test/mcp-shutdown.test.ts` は単独で **2/2成功**を確認しました。この既知baseline failureは1.0.3のTASK BOX変更として修正・抑制していません。

## TASK BOX 1.0.4 — macOS TCC identity安定化 / 2026-09-11

`Screen Recording` と `Accessibility` がTASK BOX本体差し替え後に毎回missingへ戻る原因を、稼働中 `/Applications/Chat On Steroids.app` のcode signatureから確認しました。従来candidateは `codesign --force --deep --sign -` でad-hoc再署名しており、Designated Requirementが `cdhash` だけに結びついていました。そのためASARやcompanionを変更して再署名するたびにcdhashが変わり、macOS TCCからは前回許可したappとは別identityになっていました。通常の終了・起動だけではbundleを変更していません。

1.0.4では公式releaseのunsigned/ad-hoc配布方針は変更しません。ROCANIIRUのmacOS候補作成だけに `scripts/macos-local-signing.mjs` を置き、利用Macの `macos-code-signing.json` が存在する場合はKeychain上の固定code-signing identityで候補全体を署名します。設定済みidentityが見つからない場合はad-hocへ暗黙fallbackせず候補作成を拒否します。自己署名identityはDeveloper IDやnotarizationの代替ではなく、同一Mac上で `identifier + certificate root` のDesignated Requirementを維持するためだけのものです。private keyはKeychain外へ保存しません。

この変更ではTASK BOX protocol `1` / DOM adapter revision `3`、Clear処理、Project lifecycle、保存状態を変更しません。署名identityをad-hocから固定certificateへ一度だけ移すため、切替直後のmacOS権限は利用者が最後に1回再承認する必要があります。その後は同じKeychain identityで署名されるTASK BOX更新ではDesignated Requirementが維持され、更新ごとの削除→再追加を要求しないことを実機で確認して閉じます。

## TASK BOX 1.0.5 — ChatGPT plugin refresh current-route adapter / 2026-09-11

ChatGPT の Plugins 管理入口が変わり、公式2.0.8 companionに残る旧 `/#settings/Plugins` root helper はrefresh対象へ到達できなくなった。1.0.5では公式companion原本を直接更新せず、TASK BOX候補生成時に `plugin-refresh-adapter.mjs` が検証済み公式bytesへ狭い変換を適用する。

現行経路は **`/plugins` → exact installed plugin detail → `#settings/Plugins/<plugin_id>`**。helperは必ず `/plugins` から開始し、`Installed / インストール済み` の直下にある `/plugins/plugin_asdk_app_*` linkだけを候補とする。既知 `appId` がある場合はそのexact IDを要求し、初回だけdisplay nameのexact leaf matchを許す。public catalogue card、重複候補、未知route、入力中の管理画面は証拠として扱わない。

管理画面では既存のdurable schema claimを維持する。schemaが既にcurrentならclickせずcurrent ACK、差分がある場合だけmain-process claim成功後に1回だけclickし、その後に期待schemaをread-backできた場合だけcompleteとする。click候補はvisible/enabledなbuttonで、accessible textが `更新する` / `Refresh` / `Update` のexact matchかつ `aria-haspopup` を持たないものに限定する。候補が0件または複数、claim拒否、navigation変化、schema不一致はfail-closed。

adapterは公式 `background.js` / `content.js` / `chatgpt-dom.js` の既知seamをそれぞれexactly-onceで要求する。将来の公式更新でseamが変わった場合は候補生成を拒否し、upstream absorption reviewで「公式側が同等修正を取り込んだのか」「adapterを新しい公式shapeへ更新すべきか」を確認してからrelease tableを進める。旧root routeへ暗黙fallbackしない。

1.0.5を2.0.8へcontrolled applyしたライブ確認では、本体停止・置換・起動は各1回で成功し、Clear ledgerは切替前後で同一hashを保持した。stable companionも1.0.5へ更新され、Chrome標準Reloadを1回行った。ただし実環境は `ui.browserOnly:true` で、公式2.0.8 backgroundがこのchat-recovery設定をautomatic plugin refreshにも流用していたため、pending Core/Desktop/Pluginsが再scheduleされてもhelper tabが作られなかった。さらに同じ公式backgroundの `pluginRefreshOwner` marker復旧枝だけ旧root route判定が残り、3 surfaceに対してpending対象を2件へ切っていた。したがって1.0.5のlive acceptanceは **未完了** とし、この不足を次版で前進修正する。

## TASK BOX 1.0.6 — automatic plugin refresh ownership/reliability completion / 2026-09-11

1.0.6は上記ライブ確認で見つかった残りのofficial-2.0.8前提を、同じfail-closed adapterへ統合する。Automatic plugin refreshは `autoRefreshPlugins` が公開したrefresh obligationそのものを根拠とし、chat recoveryの `browserOnly` では抑止しない。pending対象はCore / Desktop / Pluginsの最大3 surfaceを同じbatch scopeに保持する。2.0.7/2.0.8の `pluginRefreshOwner` marker復旧は `/plugins` index・exact `/plugins/plugin_asdk_app_*` detail・そのexact `#settings/Plugins/<plugin_id>` management routeだけを認め、旧 `/#settings/Plugins` へ戻さない。owner tabを利用者が閉じた場合に毎pollで再作成しない既存の安全意味は維持する。

2.0.8で初めて公開されたPlugins surfaceについては、ChatGPT App IDがまだ未登録のままprovider側に旧schemaが見えている移行も扱う。display nameだけではclaimせず、旧snapshotが新しいlocal declarationの**2個以上の完全一致toolから成るsubset**である場合だけ初回enrollmentを許可し、foreign tool・同名だが変更されたdeclarationは拒否する。これは後続の検証済みplugin-refresh reliability修正と同じ証拠境界であり、2.0.6/2.0.7のmainには存在しないPlugins surfaceを追加しない。

このため2.0.8では公式compiled mainのplugin-refresh enrollment seamもexactly-onceで変換する。公式Clear callback本文は変更せず、変換を逆適用すれば元の公式main全byteを復元できることを検査する。descriptorは `pluginRefreshMainAdapted:true` / `officialClearBodyPreserved:true` を記録し、main本文が完全無変更であるとは主張しない。未知seam・将来版は候補生成を止める。

## TASK BOX 1.0.8 — CoS 2.0.9 MCP / Desktop recovery / 2026-09-12

2.0.9ではCore / Desktop / Pluginsのtool declarationが変わる一方、旧plugin-refresh receiptが「Refreshを1回要求したが、新schemaのread-backを観測できなかった」状態で `attempted:true` に固定される実機事象を確認した。1.0.8は**同じRefreshを再クリックしない**。attempted行はexact App IDと現行publicationに結び付いた `verifyOnly` requestとして継続提示し、provider側のexact schemaがcurrentになった観測だけで `completedSchemaId` を修復する。providerが旧schemaのままならclickは0回でfail-closedを維持する。owner-tabの既存再利用・利用者が閉じたhelperを毎pollで再作成しない境界も維持する。

同時に、setup UIが「connectorを作成したことがない」と誤表示していた原因を修正する。`lastRequestAt` / `lastToolCallAt` のcurrent-session clockは診断用として残しつつ、ChatGPTから実際に到達したsurfaceごとのrequest/tool時刻を `mcp-activity` にdurable保存する。再起動後はそのhistorical値をfallbackとして使うため、再起動だけでCore / Desktop / Pluginsが未登録扱いへ戻らない。self-testとtunnel probeは従来どおり証拠に含めない。

macOS Desktopの `FOCUS_FAILED` はTCC identity不一致ではなく、pointer入力にもkeyboardと同じfocused-control証明を要求していたことが原因だった。2.0.9の公式 `native/macos-desktop-helper/main.swift` をSHA-256で固定し、pointerは **frontmost application + WindowServer front window + AX focused window**、keyboard/typeはそれに **focused UI element ownership** を加えた従来の厳しい証明、と境界を分離する。変換対象sourceが既知hashと一致しなければ候補生成を拒否し、生成したarm64 dylibはcandidate bundle内だけへ配置する。TCC resetや署名identity変更は行わない。

実機受け入れでは1.0.8を2.0.9へcontrolled applyし、Quit / apply / startを各1回だけ実行した。固定certificateのDesignated Requirementを維持し、updaterは `task-box-addon@1.0.8` をadopt、companion reload後は `reloadRequired:false` / `activationRequired:false`。Core / Desktop / Pluginsのrefresh receiptは全て `completedSchemaId == schemaId`、`mcp-activity`にも3 surfaceのrequest/tool時刻を記録した。macOS native backendは `screen=granted accessibility=granted execution=in-process`、ChromeのCoS extension buttonへの実クリックは最終1.0.8上で **1/1 via UIA** で成功し、`FOCUS_FAILED` は再現しなかった。

## CoS 2.1.11 compatibility — TASK BOX 1.0.8 / 2026-09-15

2.1.11はTASK BOX機能版を上げず、既存の1.0.8を新しい公式本体へ接続する互換性更新として扱う。公式macOS arm64 ZIPの公開SHA-256 `03954e930e4d10f48a401701fe010e04f48c62c217c482a821a38db44df40499`、tag commit `f51acbccdd734f524799ea92bb747be765fba1e4`、Bridge protocol 13、main / companion / full bundle fingerprintをfresh artifactから照合した。macOS Desktop Swift sourceは2.0.9とbyte-identicalであり、pointer/keyboard proof分離修復は同じ固定sourceへcarry-forwardする。

release-intake上は既存MCP修復seamが必要に見えたが、exact `patcher:check` は2.1.11で公式側に追加された `identityRecovery.clear()` とstartup activation guardにより2.0.9用の完全一致transformを拒否した。そこで旧seamを緩めず、**2.1.11の新しい公式guard/stateを保存する版別transform**を追加した。配布物release matrixは2.0.6 / 2.0.7 / 2.0.8 / 2.0.9 / 2.1.11を全て通し、TASK BOX/updater targeted tests、typecheck、build、candidate codesign verificationも通過した。full verifyの唯一の既知失敗は、このworktreeのbundled `resources/rg/rg`ではなくhost `/opt/homebrew/bin/rg`を選ぶ既存PATH環境差で、2.1.11 adapter変更とは独立している。`mcp-shutdown`は単独PASS。

live cutoverは2026-09-15に完了した。2.0.9の稼働bundleをrollbackとして保持したまま、事前に全体fingerprintと署名を検証した2.1.11 candidateへ **Quit 1回 / Replace 1回 / Start 1回** で直接切り替えた。稼働後のfull bundle fingerprintは `5d08a530c5c9594825c869da51a26260db16351a9b7b03e88c958d4a4f345c41`、rollback bundleは `ea896ad15f6e119c45e4b996c5a585395040649edbe5f2694c1060418b7e37dd`。Designated Requirementは `identifier "com.chatonsteroids.app" and certificate root = H"5b6a7c5a92194667f42adc4b21288aa600ac56f9"` のまま維持した。

updaterは `appliedVersion:2.1.11` / `appliedPatchCommit:task-box-addon@1.0.8` / `activationRequired:false` / `reloadRequired:false` / `lastError:null` を確認した。TASK BOX Clear ledgerは切替前後でSHA-256 `7e44a84a4ff7f45620e4ab8608d4b500ab24e318a213426b18daa43552a53476` を保持し、`busy:null`、既存20 receiptは全て `completed` のまま。Chrome companionは2.1.11へ更新し、既存Chrome profileを維持してprofile switchingは行わなかった。

Core / Desktop / Pluginsは2.1.11上で実callを通し、`mcp-activity` に3 surfaceのrequest/tool時刻がdurable記録された。各surfaceの新schema refreshは irreversible click を1回だけclaimした後、直後のread-backが曖昧な場合に再クリックせず `verifyOnly` を維持した。provider側がcurrentになった後に各helper pageを1回reloadして再観測し、最終的に3行すべて `completedSchemaId == schemaId` を確認した。CoreではChatGPT側に2.1.11で追加された `exec` declaration（`Allow unattributed calls enabled` を含む文面）が実際に公開されていることも確認した。

macOS native backendは `screen=granted accessibility=granted execution=in-process`。Desktop UIAによるharmless browser操作も成功し、更新後もpointer pathは動作した。以上により **CoS 2.1.11 + TASK BOX 1.0.8 live acceptance = PASS** とする。

切替runnerの外部所有には `launchctl submit` を使用したが、このMacではsuccessful exit後もsubmitted jobがlaunchdに残り、およそ10秒間隔で再起動された。最初のrunだけがQuit/Replace/Startへ進み、stageを消費した後の全再起動は冒頭の `verified stage missing before quit` でfail-closedしたため追加mutationは0だった。jobは直ちにlaunchd domainから削除し、以後存在しないことを確認した。**`launchctl submit` はone-shot cutover primitiveとして使用しない。** 事故事実はroot `incident.md` に分離して残す。
