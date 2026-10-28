
'use strict';

// ============================================================
// 1. 基本設定と状態管理
// ============================================================

// SVGに関する設定
const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 1000;
const HEIGHT = 620;
const RADIUS = 24;

// HTML要素をIDから取得する関数
const el = id => document.getElementById(id);

// ロボットとシミュレーターの状態
let robots = [];
let observerId = null;
let missingId = null;
let target = null;
let selectingTarget = false;

// ドラッグ操作の状態
let dragId = null;
let dragMoved = false;
let dragStart = null;

 // ============================================================
 // 自律移動・アニメーションの設定
 // ============================================================

 // アニメーションの移動時間（ミリ秒）
 const MOVE_DURATION = 1200;

 // 移動中かどうか
 let isMoving = false;

 // 移動開始時点の視野欠損候補
 let frozenCandidates = [];

 // 移動ルールの実行結果を表示するメッセージ
 let movementMessage = null;

// ============================================================
// 移動履歴の管理
// ============================================================

// 移動前の状態を保存する配列
let moveHistory = [];

// 現在の状態を履歴に保存
function saveMoveState() {

    const state = {
        robots: robots.map(r => ({
            id: r.id,
            x: r.x,
            y: r.y
        })),

        observerId: observerId,
        missingId: missingId
    };

    moveHistory.push(state);
}

// 直前の移動前の状態に戻す
function undoMove() {

    if (isMoving || moveHistory.length === 0) {
        return;
    }

    const previousState = moveHistory.pop();

    // ロボットの座標を復元
    robots = previousState.robots.map(r => ({ ...r }));

    // 観測状態を復元
    observerId = previousState.observerId;
    missingId = previousState.missingId;

    // 移動先をリセット
    target = null;
    selectingTarget = false;

    movementMessage = '1手前の状態に戻しました。';

    render();
}

// SVGキャンバス
const svg = el('canvas');


// ============================================================
// 2. 基本的な計算・視野欠損・観測者の管理
// ============================================================

// 値をmin～maxの範囲に制限する
function clamp(x, min, max) {
    return Math.max(min, Math.min(max, x));
}

// 2台のロボット間のユークリッド距離
function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

// マウスの位置をSVG上の座標に変換する
function point(evt) {
    const p = svg.createSVGPoint();

    p.x = evt.clientX;
    p.y = evt.clientY;

    const mat = svg.getScreenCTM();

    if (!mat) {
        return { x: 500, y: 310 };
    }

    const s = p.matrixTransform(mat.inverse());

    return {
        x: clamp(s.x, RADIUS, WIDTH - RADIUS),
        y: clamp(s.y, RADIUS, HEIGHT - RADIUS)
    };
}

// SVG要素を生成する
function node(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);

    for (const [k, v] of Object.entries(attrs)) {
        n.setAttribute(k, String(v));
    }

    if (parent) {
        parent.appendChild(n);
    }

    return n;
}

// 現在の観測ロボットを取得
function getObserver() {
    return robots.find(r => r.id === observerId);
}

// 観測ロボットから最も遠いロボットのID一覧を取得
function farthestIds() {
    const obs = getObserver();

    if (!obs) {
        return [];
    }

    // 観測ロボット自身は除外
    const others = robots.filter(r => r.id !== obs.id);

    if (!others.length) {
        return [];
    }

    // 観測ロボットとの距離を計算
    const ds = others.map(r => ({
        id: r.id,
        d: distance(obs, r)
    }));

    // 最大距離
    const max = Math.max(...ds.map(o => o.d));

    // 最大距離と等しいロボットをすべて抽出
    return ds
        .filter(o => Math.abs(o.d - max) <= 1e-7)
        .map(o => o.id)
        .sort((a, b) => a - b);
}

// 欠損対象のロボットを決定
function calculateMissing() {
    const candidates = farthestIds();

    // 現在の欠損対象が候補から外れた場合のみ更新
    if (!candidates.includes(missingId)) {
        missingId = candidates[0] ?? null;
    }

    return candidates;
}

// 観測ロボットを変更
function chooseObserver(id) {
    observerId = id;
    missingId = null;
    target = null;
    selectingTarget = false;

    render();
}


// ============================================================
// 3. 直線判定
// ============================================================

// 3点の外積を計算
function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y)
         - (b.y - a.y) * (c.x - a.x);
}

// 3点が同一直線上にあるか判定
function collinear(a, b, c, tol) {
    const len = distance(a, b);

    // aとbが同じ位置にある場合
    if (len < 1e-9) {
        return distance(a, c) <= tol;
    }

    // 点cから直線abまでの垂直距離で判定
    return Math.abs(cross(a, b, c)) / len <= tol;
}

// 3台以上のロボットが並ぶ直線群を取得
function lineGroups() {
    const tol = Number(el('lineTol').value) || 0;
    const found = new Map();

    // 2台のロボットを選んで直線を定義
    for (let i = 0; i < robots.length; i++) {
        for (let j = i + 1; j < robots.length; j++) {
            const a = robots[i];
            const b = robots[j];

            // 同じ座標にある2台は直線を定義できない
            if (distance(a, b) < 1e-9) {
                continue;
            }

            // 直線ab上に存在するロボットを取得
            const group = robots.filter(r =>
                collinear(a, b, r, tol)
            );

            // 3台未満の場合は対象外
            if (group.length < 3) {
                continue;
            }

            // ロボット番号を昇順に並べる
            const ids = group
                .map(r => r.id)
                .sort((x, y) => x - y);

            const key = ids.join(',');

            // 同じグループが登録済みならスキップ
            if (found.has(key)) {
                continue;
            }

            // 直線の方向ベクトル
            const dx = b.x - a.x;
            const dy = b.y - a.y;

            // 直線方向への射影値で並び替え
            const sorted = group.slice().sort((r, s) => {
                const projectionR =
                    (r.x - a.x) * dx + (r.y - a.y) * dy;

                const projectionS =
                    (s.x - a.x) * dx + (s.y - a.y) * dy;

                return projectionR - projectionS;
            });

            // 直線の両端を保存
            found.set(key, {
                ids,
                a: sorted[0],
                b: sorted.at(-1)
            });
        }
    }

    // 他の直線群に完全に含まれるグループを除去
    return [...found.values()]
        .filter((g, _, all) =>
            !all.some(h =>
                h !== g &&
                g.ids.every(id => h.ids.includes(id))
            )
        )
        .sort((a, b) => b.ids.length - a.ids.length);
}

function isOnLineOfThree(observer, visibleRobots) {

    const tol = Number(el('lineTol').value) || 0;

    // 観測可能な他のロボットから2台を選ぶ
    for (let i = 0; i < visibleRobots.length; i++) {

        for (let j = i + 1; j < visibleRobots.length; j++) {

            const robotA = visibleRobots[i];
            const robotB = visibleRobots[j];

            // 観測ロボット自身を含めた3台が共線か判定
            if (
                distance(observer, robotA) > 1e-9 &&
                distance(observer, robotB) > 1e-9 &&
                distance(robotA, robotB) > 1e-9 &&
                collinear(observer, robotA, robotB, tol)
            ) {
                return true;
            }
        }
    }

    return false;
}


// ============================================================
// 4. SVGキャンバスの描画
// ============================================================

// 背景のグリッド線を描画
function paintGrid() {
    const g = el('grid');
    g.replaceChildren();

    // 縦線
    for (let x = 50; x < WIDTH; x += 50) {
        node('line', {
            class: 'gridline',
            x1: x,
            y1: 0,
            x2: x,
            y2: HEIGHT
        }, g);
    }

    // 横線
    for (let y = 50; y < HEIGHT; y += 50) {
        node('line', {
            class: 'gridline',
            x1: 0,
            y1: y,
            x2: WIDTH,
            y2: y
        }, g);
    }
}

// 共線ロボットを結ぶ直線を描画
function paintLines(groups) {
    const layer = el('lines');
    layer.replaceChildren();

    for (const line of groups) {
        node('line', {
            x1: line.a.x,
            y1: line.a.y,
            x2: line.b.x,
            y2: line.b.y,
            stroke: '#3b86ef',
            'stroke-width': 5,
            'stroke-linecap': 'round',
            opacity: 0.75
        }, layer);
    }
}

// 移動先のマーカーと移動経路を描画
function paintTarget() {
    const layer = el('targetLayer');
    layer.replaceChildren();

    if (!target) {
        return;
    }

    const { x, y } = target;

    // 移動先を円で囲む
    node('circle', {
        cx: x,
        cy: y,
        r: 14,
        stroke: '#16a66a',
        'stroke-width': 3,
        fill: 'none',
        'stroke-dasharray': '4 4'
    }, layer);

    // 十字マーカー
    node('path', {
        d: `M${x - 20} ${y}H${x + 20}M${x} ${y - 20}V${y + 20}`,
        stroke: '#16a66a',
        'stroke-width': 2
    }, layer);

    // 観測ロボットから移動先までの線
    const o = getObserver();

    if (o) {
        node('line', {
            x1: o.x,
            y1: o.y,
            x2: x,
            y2: y,
            stroke: '#16a66a',
            'stroke-width': 2,
            'stroke-dasharray': '7 6'
        }, layer);
    }
}

// ロボットを描画
function paintRobots() {
    const layer = el('robots');
    layer.replaceChildren();

    for (const r of robots) {
        const group = node('g', {
            'data-id': r.id,
            class: 'robot'
        }, layer);

        // 視野欠損対象かどうか
        const hidden = r.id === missingId;

        // ロボットの円
        node('circle', {
            cx: r.x,
            cy: r.y,
            r: RADIUS,
            fill: '#fff',
            stroke: r.id === observerId
                ? '#ec4551'
                : '#172238',
            'stroke-width': r.id === observerId ? 5 : 3,
            opacity: hidden ? 0.26 : 1
        }, group);

        // ロボット番号
        const label = node('text', {
            x: r.x,
            y: r.y + 7,
            'text-anchor': 'middle',
            opacity: hidden ? 0.26 : 1
        }, group);

        label.textContent = String(r.id);

        // マウス操作を受け付ける透明な領域
        node('circle', {
            cx: r.x,
            cy: r.y,
            r: RADIUS + 8,
            fill: 'transparent'
        }, group);
    }
}


// ============================================================
// 5. 操作パネルの表示更新
// ============================================================

function updateControls(candidates, groups) {
    const o = getObserver();

    // 現在の欠損対象以外の候補
    const other = candidates.filter(id => id !== missingId);

    // --------------------------------------------------------
    // 観測ロボットの選択メニュー
    // --------------------------------------------------------

    const observerSelect = el('observerSelect');
    const previousValue = observerSelect.value;

    observerSelect.replaceChildren();

    for (const r of robots) {
        const opt = document.createElement('option');

        opt.value = String(r.id);
        opt.textContent = r.id + '番';

        observerSelect.append(opt);
    }

    if (robots.length) {
        observerSelect.value = String(
            observerId ??
            (
                robots.some(r => String(r.id) === previousValue)
                    ? Number(previousValue)
                    : robots[0].id
            )
        );
    }

    observerSelect.disabled = !robots.length;
    el('setObserverBtn').disabled = !robots.length;

    // --------------------------------------------------------
    // ステータス表示
    // --------------------------------------------------------

    el('robotStatus').textContent =
        `ロボット: ${robots.length}台`;

    el('observerStatus').textContent =
        `観測者: ${o ? o.id + '番' : '未指定'}`;

    el('missingStatus').textContent =
        `欠損: ${missingId === null ? 'なし' : missingId + '番'}`;

    el('positionStatus').textContent = o
        ? `観測者座標: (${Math.round(o.x)}, ${Math.round(o.y)})`
        : '観測者座標: ―';

    // --------------------------------------------------------
    // 視野欠損に関する説明文
    // --------------------------------------------------------

    el('observeMessage').textContent = o
        ? (
            `観測ロボットは${o.id}番です。` +
            (
                missingId === null
                    ? '欠損対象はありません。'
                    : `${missingId}番のロボットは最遠方のため観測できません。`
            ) +
            (
                other.length
                    ? '\n' +
                      other.map(id => id + '番').join('、') +
                      'のロボットも欠損対象となり得ます。'
                    : ''
            )
        )
        : (
            '番号を選んで「観測ロボットに設定」を押すか、' +
            'キャンバスのロボットを1回クリックしてください。'
        );

    el('observeMessage').style.whiteSpace = 'pre-line';

    // --------------------------------------------------------
    // 等距離の場合の欠損対象切り替えメニュー
    // --------------------------------------------------------

    const sel = el('tieSelect');
    sel.replaceChildren();

    if (candidates.length > 1) {
        for (const id of candidates) {
            const opt = document.createElement('option');

            opt.value = String(id);
            opt.textContent = `${id}番を欠損`;

            sel.append(opt);
        }

        sel.value = String(missingId);
        sel.disabled = false;

    } else {
        const opt = document.createElement('option');

        opt.textContent = candidates.length
            ? `${candidates[0]}番（唯一の候補）`
            : '対象なし';

        sel.append(opt);
        sel.disabled = true;
    }

    // --------------------------------------------------------
    // 移動操作ボタンの状態
    // --------------------------------------------------------

// --------------------------------------------------------
// 移動操作ボタンの状態
// --------------------------------------------------------

// 自律移動ボタン
el('autoMoveBtn').disabled = !o || isMoving;
 
// 1手戻すボタンの有効・無効を設定
el('undoMoveBtn').disabled =
    isMoving || moveHistory.length === 0;


// 手動移動ボタン
el('chooseTargetBtn').disabled = !o || isMoving;
el('moveBtn').disabled = !o || !target || isMoving;

el('cancelTargetBtn').disabled =
    (!target && !selectingTarget) || isMoving;

// 移動先指定ボタンの文言
el('chooseTargetBtn').textContent = selectingTarget
    ? 'キャンバスをクリックしてください'
    : '移動先をキャンバス上で指定';

// 自律移動中の表示
if (isMoving) {

    el('targetText').textContent =
        movementMessage || '自律移動中です。';

} else if (movementMessage) {

    el('targetText').textContent = movementMessage;

} else if (target) {

    el('targetText').textContent =
        `移動先: (${Math.round(target.x)}, ${Math.round(target.y)})`;

} else if (selectingTarget) {

    el('targetText').textContent =
        'キャンバス上で移動先を指定してください。';

} else {

    el('targetText').textContent =
        '観測ロボットを選択してください。';
}

// 移動中はロボット配置や観測変更を禁止
el('placeBtn').disabled = isMoving;
el('clearBtn').disabled = isMoving;
el('robotCount').disabled = isMoving;
el('cancelObserver').disabled = isMoving;
el('lineTol').disabled = isMoving;

observerSelect.disabled = isMoving || !robots.length;
el('setObserverBtn').disabled = isMoving || !robots.length;

if (isMoving) {
    sel.disabled = true;
}

    // --------------------------------------------------------
    // 直線判定結果の表示
    // --------------------------------------------------------

    el('lineMessage').textContent = groups.length
        ? groups
            .map(g =>
                `${g.ids.join('・')}番のロボットが一直線上にあります。`
            )
            .join('\n')
        : '3台以上のロボットが一直線上にある組はありません。';

    el('lineMessage').style.whiteSpace = 'pre-line';
}


// ============================================================
// 6. 画面更新・ロボット配置・全消去
// ============================================================

// 画面全体の再描画
function render() {

    // 移動中はLook時点の視野欠損を維持
    const candidates = isMoving
        ? frozenCandidates
        : calculateMissing();

    const groups = lineGroups();

    paintLines(groups);
    paintTarget();
    paintRobots();

    updateControls(candidates, groups);
}

// ロボットを初期配置する
function placeRobots() {
    let n = Math.floor(Number(el('robotCount').value));

    if (!Number.isFinite(n)) {
        n = 4;
    }

    n = clamp(n, 1, 60);
    el('robotCount').value = n;

    // ロボットを格子状に配置する
    robots = Array.from({ length: n }, (_, i) => {
        const cols = Math.ceil(Math.sqrt(n * WIDTH / HEIGHT));
        const rows = Math.ceil(n / cols);

        const col = i % cols;
        const row = Math.floor(i / cols);

        return {
            id: i + 1,
            x: Math.round((col + 1) * WIDTH / (cols + 1)),
            y: Math.round((row + 1) * HEIGHT / (rows + 1))
        };
    });

    // 観測状態を初期化
    observerId = null;
    missingId = null;
    target = null;
    selectingTarget = false;

    render();
 moveHistory = [];
movementMessage = null;
}

// 全ロボットを消去
function clearAll() {
    robots = [];
    observerId = null;
    missingId = null;
    target = null;
    selectingTarget = false;

    render();
 moveHistory = [];
movementMessage = null;
}


// ============================================================
// 7. ロボットの移動処理
// ============================================================

// ------------------------------------------------------------
// 【将来の自律移動ルール追加箇所】
//
// この関数内に研究で定めた
// 「Look → Compute → Move」のCompute規則を実装する。
//
// observer     : 観測ロボット
// visibleRobots: 観測可能な他のロボット
//
// 戻り値:
//   {x, y} : 移動先の座標
//   null   : 移動しない場合
//
// 注意:
//   現在は移動先を自動計算していない。
//   将来的には、観測可能な情報だけを使って
//   移動先を求めるアルゴリズムを実装する。
// ------------------------------------------------------------


// ============================================================
// ルール1：直線を構成していなければ最短辺の中点へ移動
// ============================================================

function computeRule1(observer, visibleRobots) {

    // 観測可能な他ロボットが2台未満なら適用不可
    if (visibleRobots.length < 2) {
        return null;
    }

    // 条件：自身が3台以上の直線を構成していない
    if (isOnLineOfThree(observer, visibleRobots)) {
        return null;
    }

    // 最短辺を探索
    let shortestPair = null;
    let minDistance = Infinity;

    const sorted = [...visibleRobots].sort(
        (a, b) => a.id - b.id
    );

    for (let i = 0; i < sorted.length; i++) {

        for (let j = i + 1; j < sorted.length; j++) {

            const a = sorted[i];
            const b = sorted[j];

            const d = distance(a, b);

            if (d < minDistance - 1e-7) {
                minDistance = d;
                shortestPair = [a, b];
            }
        }
    }

    if (!shortestPair) {
        return null;
    }

    const [a, b] = shortestPair;

    // 最短辺の中点を移動先とする
    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        pair: [a.id, b.id]
    };
}

// ============================================================
// 自律移動アルゴリズム（Compute）
// ============================================================

function computeAutonomousDestination(observer, visibleRobots) {

    // ルール1を判定
    const rule1 = computeRule1(observer, visibleRobots);

    if (rule1 !== null) {
        return {
            ...rule1,
            rule: 1
        };
    }

    // ========================================================
    // TODO：ここにルール2を追加
    // ========================================================

    // ========================================================
    // TODO：ここにルール3を追加
    // ========================================================

    // どの移動ルールにも該当しない場合
    return null;
}

// ============================================================
// 自律移動を実行：Look → Compute → Move
// ============================================================


// ============================================================
// 自律移動の実行：Look → Compute → Move
// ============================================================

function executeAutonomousMove() {

    if (isMoving) {
        return;
    }

    const observer = getObserver();

    if (!observer) {
        return;
    }

    // --------------------------------------------------------
    // Look：観測
    // --------------------------------------------------------

    // 視野欠損対象を確定
    calculateMissing();

    // 観測時点の情報をスナップショットとして保存
    const observerSnapshot = {
        x: observer.x,
        y: observer.y
    };

    // 観測可能な他のロボットだけを取得
    const visibleRobots = robots
        .filter(r =>
            r.id !== observer.id &&
            r.id !== missingId
        )
        .map(r => ({
            id: r.id,
            x: r.x,
            y: r.y
        }));

    // --------------------------------------------------------
    // Compute：ルールを自動判定
    // --------------------------------------------------------

    const result = computeAutonomousDestination(
        observerSnapshot,
        visibleRobots
    );

    // 適用できるルールがない場合
    if (result === null) {

        movementMessage =
            '適用可能な移動ルールがありません。';

        render();
        return;
    }

    // --------------------------------------------------------
    // Move：アニメーションによる移動
    // --------------------------------------------------------

    target = {
        x: result.x,
        y: result.y
    };

    movementMessage =
        `ルール${result.rule}適用：` +
        `${result.pair.join('番・')}番の中点へ移動中`;

    console.log(`適用ルール：${result.rule}`);
    console.log(`移動先：(${result.x}, ${result.y})`);

    animateObserverTo(target);
}


// ============================================================
// アニメーションによるロボットの移動
// ============================================================

function animateObserverTo(destination) {

    const observer = getObserver();

    // 移動できない場合
if (!observer || !destination || isMoving) {
    return;
}

// 移動前の状態を履歴に保存
saveMoveState();

// 移動開始
isMoving = true;

    // Look時点の欠損候補を保存
    frozenCandidates = farthestIds();

    // 移動開始位置
    const startX = observer.x;
    const startY = observer.y;

    // 移動先
    const endX = clamp(destination.x, RADIUS, WIDTH - RADIUS);
    const endY = clamp(destination.y, RADIUS, HEIGHT - RADIUS);

    let startTime = null;

    // アニメーションの各フレームで呼び出される
    function animate(timestamp) {

        if (startTime === null) {
            startTime = timestamp;
        }

        // 移動の進行率（0～1）
        const elapsed = timestamp - startTime;

        const progress = Math.min(
            elapsed / MOVE_DURATION,
            1
        );

        // 現在位置を計算
        observer.x = startX + (endX - startX) * progress;
        observer.y = startY + (endY - startY) * progress;

        // 画面更新
        render();

        // まだ移動中の場合
        if (progress < 1) {

            requestAnimationFrame(animate);

        } else {

            // 移動完了
            observer.x = endX;
            observer.y = endY;

            isMoving = false;
            frozenCandidates = [];

            target = null;
            selectingTarget = false;

            movementMessage = '移動が完了しました。';

            render();
        }
    }

    requestAnimationFrame(animate);
}



// ============================================================
// 手動移動処理
// ============================================================

function moveObserverTo(destination) {

    const obs = getObserver();

    if (!obs || !destination || isMoving) {
        return;
    }

    // 移動前の状態を保存
    saveMoveState();

    // 移動
    obs.x = clamp(
        destination.x,
        RADIUS,
        WIDTH - RADIUS
    );

    obs.y = clamp(
        destination.y,
        RADIUS,
        HEIGHT - RADIUS
    );

    target = null;
    selectingTarget = false;

    movementMessage = '手動移動が完了しました。';

    render();
}



// ============================================================
// 8. ボタン操作・マウス操作
// ============================================================
 el('autoMoveBtn').addEventListener('click', () => {
     executeAutonomousMove();
 });
el('undoMoveBtn').addEventListener('click', () => {
    undoMove();
});
// 観測ロボット設定ボタン
el('setObserverBtn').addEventListener('click', () => {
    const id = Number(el('observerSelect').value);

    if (robots.some(r => r.id === id)) {
        chooseObserver(id);
    }
});

// ロボット配置ボタン
el('placeBtn').addEventListener('click', placeRobots);

// 全消去ボタン
el('clearBtn').addEventListener('click', clearAll);

// 観測ロボット指定解除
el('cancelObserver').addEventListener('click', () => {
    observerId = null;
    missingId = null;
    target = null;
    selectingTarget = false;

    render();
});

// 欠損対象の切り替え
el('tieSelect').addEventListener('change', e => {
    missingId = Number(e.target.value);

    render();
});

// 直線判定の許容誤差が変更された場合
el('lineTol').addEventListener('change', render);

// 移動先指定開始
el('chooseTargetBtn').addEventListener('click', () => {
    if (!getObserver()) {
        return;
    }

    selectingTarget = true;
    render();
});

// 指定先へ移動
el('moveBtn').addEventListener('click', () => {
    moveObserverTo(target);
});

// 移動先指定解除
el('cancelTargetBtn').addEventListener('click', () => {
    target = null;
    selectingTarget = false;

    render();
});


// ------------------------------------------------------------
// ロボットのドラッグ操作
// ------------------------------------------------------------

// マウスを押したとき
svg.addEventListener('pointerdown', e => {
    const g = e.target.closest('.robot');

if (!g || selectingTarget || isMoving) {
    return;
}

    dragId = Number(g.dataset.id);
    dragMoved = false;
    dragStart = point(e);

    svg.setPointerCapture(e.pointerId);
});

// マウスを動かしたとき
svg.addEventListener('pointermove', e => {
    if (dragId === null) {
        return;
    }

    const r = robots.find(r => r.id === dragId);

    if (!r) {
        return;
    }

    const p = point(e);

    // 4px以上動いた場合にドラッグと判断
    if (
        dragStart &&
        Math.hypot(
            dragStart.x - p.x,
            dragStart.y - p.y
        ) > 4
    ) {
        dragMoved = true;
    }

    if (!dragMoved) {
        return;
    }

    r.x = p.x;
    r.y = p.y;

    render();
});

// ドラッグ終了処理
function endDrag(e) {
    if (dragId !== null) {
        const clickedId = dragId;
        const wasDragged = dragMoved;

        dragId = null;
        dragStart = null;

        if (svg.hasPointerCapture(e.pointerId)) {
            svg.releasePointerCapture(e.pointerId);
        }

        // ドラッグではなくクリックの場合は観測者を変更
        if (e.type === 'pointerup' && !wasDragged) {
            chooseObserver(clickedId);
        }
    }
}

// マウスを離したとき
svg.addEventListener('pointerup', endDrag);

// ポインター操作がキャンセルされたとき
svg.addEventListener('pointercancel', endDrag);


// ------------------------------------------------------------
// ダブルクリックによる観測ロボット指定
// ------------------------------------------------------------

svg.addEventListener('dblclick', e => {
    const g = e.target.closest('.robot');

    if (g) {
        chooseObserver(Number(g.dataset.id));
        e.preventDefault();
    }
});


// ------------------------------------------------------------
// キャンバス上で移動先を指定
// ------------------------------------------------------------

svg.addEventListener('click', e => {
    if (
        !selectingTarget ||
        e.target.closest('.robot')
    ) {
        return;
    }

    target = point(e);
    selectingTarget = false;

    render();
});


// ============================================================
// 9. シミュレーター起動時の初期化
// ============================================================

// グリッドを描画
paintGrid();

// ロボットを初期配置
placeRobots();
