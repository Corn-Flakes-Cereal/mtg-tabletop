/* global io, Konva */
(() => {
  // -------------------------------------------------------------------------
  // Setup / persistent identity
  // -------------------------------------------------------------------------
  const socket = io();

  function getOrCreatePlayerId() {
    let id = localStorage.getItem('mtg_player_id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('mtg_player_id', id);
    }
    return id;
  }
  const playerId = getOrCreatePlayerId();

  let currentCode = null;
  let latestState = null;

  // Shared by the context menu and the card preview's quick-action buttons —
  // every place a card can be relocated to, keyed by the zone name move_card
  // expects. Whichever list uses this always excludes the card's own current
  // zone (nothing moves "to" where it already is).
  const ZONE_MOVE_LABELS = [
    ['hand', 'Move to Hand'],
    ['battlefield', 'Move to Battlefield'],
    ['graveyard', 'Move to Graveyard'],
    ['exile', 'Move to Exile'],
    ['library', 'Move to top of Library'],
  ];

  // -------------------------------------------------------------------------
  // Battlefield rendering — Konva canvas, one Stage per field (yours + each
  // opponent's), instead of absolutely-positioned DOM cards. Card positions
  // live in a fixed logical "board space" (BOARD_W x BOARD_H) that each
  // Stage scales to fit its own box, so drag, zoom, and pan are all native
  // Konva behavior instead of hand-rolled CSS transform math.
  // -------------------------------------------------------------------------
  const BOARD_W = 1000;
  const BOARD_H = 640;
  const CARD_W = 90;
  const CARD_H = 126;
  // Half of the card's longer edge — used to keep a card's full footprint
  // inside the board in either orientation (tapping rotates it 90°).
  const CARD_FIT_MARGIN = 63;

  // Snapping: dropping a card within SNAP_RADIUS of another card on the same
  // battlefield lines it up neatly next to that card instead of leaving it
  // wherever it was released — keeps the board tidy without forcing a rigid
  // global grid (cards far from anything else still land exactly where
  // dropped). Whichever axis has the bigger offset from the neighbor decides
  // whether it snaps into a row (side-by-side) or a column (stacked).
  const SNAP_RADIUS = 150;
  const SNAP_GAP = 4;

  function clampToBoard(x, y) {
    return {
      x: Math.max(CARD_FIT_MARGIN, Math.min(BOARD_W - CARD_FIT_MARGIN, x)),
      y: Math.max(CARD_FIT_MARGIN, Math.min(BOARD_H - CARD_FIT_MARGIN, y)),
    };
  }

  // A tapped card is rotated 90° in place, so its visual footprint has width
  // and height swapped from its resting size — snapping needs each card's
  // ACTUAL on-screen footprint, not always the untapped one, or a tapped
  // neighbor's card would visually overlap the one snapped next to it.
  function effectiveSize(tapped) {
    return tapped ? { w: CARD_H, h: CARD_W } : { w: CARD_W, h: CARD_H };
  }

  // ownerId/draggedUid identify whose battlefield to check and which card to
  // exclude (a card never snaps to itself). draggedTapped is the tapped
  // state of the card being placed (hand cards are always untapped, so that
  // call site can omit it). Reads sibling positions straight out of
  // latestState rather than needing them passed in, since every drop path
  // already has access to that.
  function snapPosition(ownerId, draggedUid, x, y, draggedTapped = false) {
    const owner = latestState && latestState.players[ownerId];
    const siblings = owner ? owner.battlefield.filter((c) => c.uid !== draggedUid) : [];

    let nearest = null;
    let nearestDist = Infinity;
    for (const c of siblings) {
      const dx = x - c.x;
      const dy = y - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= SNAP_RADIUS && dist < nearestDist) {
        nearestDist = dist;
        nearest = { c, dx, dy };
      }
    }

    if (!nearest) return clampToBoard(x, y);

    const { c, dx, dy } = nearest;
    const draggedSize = effectiveSize(draggedTapped);
    const neighborSize = effectiveSize(!!c.tapped);
    // Offset between the two centers = half the neighbor's footprint + gap +
    // half the dragged card's footprint, along whichever axis they're lining
    // up on — using each card's real (possibly rotated) size, not always the
    // untapped one.
    const snapped = Math.abs(dx) >= Math.abs(dy)
      ? { x: c.x + (dx >= 0 ? 1 : -1) * (neighborSize.w / 2 + SNAP_GAP + draggedSize.w / 2), y: c.y } // side-by-side row
      : { x: c.x, y: c.y + (dy >= 0 ? 1 : -1) * (neighborSize.h / 2 + SNAP_GAP + draggedSize.h / 2) }; // stacked column
    return clampToBoard(snapped.x, snapped.y);
  }

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;

  // ownerId -> { stage, layer, worldScale } for every field currently on
  // screen. Read by the hand->battlefield drop handler to convert a drop's
  // screen coordinates into that field's board-space coordinates.
  const battlefieldStages = new Map();

  // Card art is loaded once per URL and reused — Konva needs a loaded
  // HTMLImageElement (not just a URL) before it can draw one.
  const IMAGE_LOAD_RETRIES = 3;
  // Dropping a handful of cards on the field at once used to fire that many
  // simultaneous image requests — enough of a burst that some would come
  // back net::ERR_FAILED (browser per-host connection cap / CDN hiccuping
  // under the spike), and with no re-render to prompt a retry under the
  // persistent-node rendering (see renderBattlefieldLayer), those cards
  // stayed blank. A small concurrency queue spreads the requests out instead
  // of firing them all at once.
  const IMAGE_LOAD_MAX_CONCURRENT = 4;
  const imageLoadQueue = [];
  let imageLoadActive = 0;
  const imageCache = new Map(); // url -> HTMLImageElement | array of pending callbacks
  function loadCardImage(url, onLoad) {
    if (!url) return;
    const cached = imageCache.get(url);
    if (cached instanceof Image) return onLoad(cached);
    if (Array.isArray(cached)) return cached.push(onLoad);
    imageCache.set(url, [onLoad]);
    enqueueImageLoad(url, 0);
  }
  function enqueueImageLoad(url, attempt) {
    imageLoadQueue.push({ url, attempt });
    pumpImageLoadQueue();
  }
  function pumpImageLoadQueue() {
    while (imageLoadActive < IMAGE_LOAD_MAX_CONCURRENT && imageLoadQueue.length) {
      const { url, attempt } = imageLoadQueue.shift();
      imageLoadActive++;
      startImageLoad(url, attempt);
    }
  }
  // The first-ever fetch of a given card image occasionally errors out (cold
  // CDN cache, a flaky network blip, or too many requests firing at once —
  // see the queue above) with no re-render to prompt a retry, so a card that
  // lost this race stayed permanently blank until something forced a full
  // rebuild, like a page refresh. Retrying a few times with a jittered
  // backoff means a transient failure recovers on its own instead.
  const IMAGE_LOAD_TIMEOUT_MS = 8000;
  function startImageLoad(url, attempt) {
    const img = new Image();
    // No crossOrigin here — Scryfall's card-art CDN doesn't send CORS headers,
    // so requesting CORS mode makes every load fail outright (confirmed:
    // that's what the ERR_FAILED/CORS-policy console errors were earlier).
    // Konva just draws the image onto the canvas, which doesn't require CORS
    // — that's only needed for reading pixels back out (getImageData/
    // toDataURL), which this app never does.
    let settled = false;
    // If the browser suspends the tab into the back/forward cache while a
    // fetch is in flight, that request is killed with neither onload nor
    // onerror ever firing on restore — confirmed by the console showing
    // "Page entered Back-Forward Cache" right when loads stalled. Without
    // this timeout, that leaks a permanent slot out of the concurrency
    // queue above, and once enough slots leak the whole queue stops
    // advancing — every card queued after that point stays on its text
    // label forever, not just the one whose request got killed.
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      img.onload = img.onerror = null;
      handleFailure();
    }, IMAGE_LOAD_TIMEOUT_MS);
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      imageLoadActive--;
      pumpImageLoadQueue();
    };
    function handleFailure() {
      done();
      if (attempt < IMAGE_LOAD_RETRIES) {
        const backoff = 400 * (attempt + 1) + Math.random() * 300;
        setTimeout(() => enqueueImageLoad(url, attempt + 1), backoff);
      } else {
        console.warn('Card image failed to load after retries:', url);
        imageCache.delete(url);
      }
    }
    img.onload = () => {
      if (settled) return; // timed out already; a stray late load shouldn't double-count
      done();
      const pending = imageCache.get(url);
      imageCache.set(url, img);
      (Array.isArray(pending) ? pending : []).forEach((cb) => cb(img));
    };
    img.onerror = handleFailure;
    img.src = url;
  }

  // Belt-and-suspenders: if the whole tab gets frozen into the bfcache and
  // restored, re-kick the queue in case anything is sitting idle with a free
  // concurrency slot that didn't get used (the per-load timeout above is the
  // real fix, this just avoids waiting up to 8s unnecessarily after a restore).
  document.addEventListener('pageshow', (e) => {
    if (e.persisted) pumpImageLoadQueue();
  });

  function roundedRectPath(ctx, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(w, 0, w, h, r);
    ctx.arcTo(w, h, 0, h, r);
    ctx.arcTo(0, h, 0, 0, r);
    ctx.arcTo(0, 0, w, 0, r);
    ctx.closePath();
  }

  // Creates a Konva Stage filling `containerEl`, wired to a zoom slider,
  // scroll wheel (pointer-relative), click-and-drag panning, and two-finger
  // touch pinch. Called exactly once per field (self at load, each opponent
  // via getOrCreateOpponentEls) — the returned stage/layer are reused across
  // renders (only the card *nodes* inside the layer get rebuilt each time),
  // so an in-progress zoom/pan is never interrupted by an unrelated game
  // update, and listeners never pile up.
  function createBattlefieldStage(containerEl, ownerId, sliderEl, labelEl) {
    // The container can be zero-sized at creation time — e.g. the self
    // battlefield exists in the DOM before the table screen is ever shown
    // (display:none collapses it to 0x0), and an opponent's battlefield div
    // may not be attached to the document yet. Fall back to something
    // reasonable so Konva has valid dimensions; resize() (called once the
    // real size is known, and again on window resize) fixes it for real.
    const stage = new Konva.Stage({
      container: containerEl,
      width: containerEl.clientWidth || 400,
      height: containerEl.clientHeight || 300,
      draggable: true, // pans when dragging empty board; Konva gives drag priority to the card under the pointer, if any
    });
    const layer = new Konva.Layer();
    stage.add(layer);

    let worldScale = stage.width() / BOARD_W;

    function centeredPos(scale) {
      return {
        x: (stage.width() - BOARD_W * scale) / 2,
        y: (stage.height() - BOARD_H * scale) / 2,
      };
    }
    function clampToBounds(pos, scale) {
      const center = centeredPos(scale);
      const maxDx = Math.max(40, (BOARD_W * scale - stage.width()) / 2 + 40);
      const maxDy = Math.max(40, (BOARD_H * scale - stage.height()) / 2 + 40);
      return {
        x: Math.max(center.x - maxDx, Math.min(center.x + maxDx, pos.x)),
        y: Math.max(center.y - maxDy, Math.min(center.y + maxDy, pos.y)),
      };
    }
    stage.dragBoundFunc(function (pos) {
      return clampToBounds(pos, stage.scaleX());
    });

    function updateControls() {
      const pct = stage.scaleX() / worldScale;
      if (sliderEl) sliderEl.value = pct;
      if (labelEl) labelEl.textContent = `${Math.round(pct * 100)}%`;
    }

    // Rescale/reposition around a fixed screen point (viewport center for the
    // slider, the pointer for wheel/pinch) so that point's board location stays put.
    function zoomAround(screenPoint, newMultiplier) {
      const newScale = worldScale * Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newMultiplier));
      const boardPoint = {
        x: (screenPoint.x - stage.x()) / stage.scaleX(),
        y: (screenPoint.y - stage.y()) / stage.scaleY(),
      };
      stage.scale({ x: newScale, y: newScale });
      stage.position(
        clampToBounds(
          { x: screenPoint.x - boardPoint.x * newScale, y: screenPoint.y - boardPoint.y * newScale },
          newScale
        )
      );
      updateControls();
      layer.batchDraw();
    }

    stage.scale({ x: worldScale, y: worldScale });
    stage.position(centeredPos(worldScale));
    updateControls();

    if (sliderEl) {
      sliderEl.addEventListener('input', () => {
        zoomAround({ x: stage.width() / 2, y: stage.height() / 2 }, parseFloat(sliderEl.value));
      });
    }

    // Scroll wheel to zoom, relative to the pointer. Trackpad pinch arrives as
    // a wheel event with ctrlKey set (and a bigger deltaY) — preventDefault
    // stops the browser's own page-zoom on that ctrl+wheel case.
    stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const factor = 1 + (e.evt.deltaY > 0 ? -0.08 : 0.08) * (e.evt.ctrlKey ? 1.6 : 1);
      const pointer = stage.getPointerPosition() || { x: stage.width() / 2, y: stage.height() / 2 };
      zoomAround(pointer, (stage.scaleX() / worldScale) * factor);
    });

    // Click-and-drag panning comes from `draggable: true` above — Konva
    // automatically prefers a card's own drag over the stage's when the
    // pointer starts on a card, so this never fights with moving cards.
    // (These dragstart/dragend fire for the stage's own drag only — a card
    // dragging itself doesn't bubble up as the stage being dragged.)
    stage.on('dragmove', updateControls);
    stage.on('dragstart', () => (containerEl.style.cursor = 'grabbing'));
    stage.on('dragend', () => (containerEl.style.cursor = 'grab'));

    // Two-finger touch pinch. Stage dragging already covers one-finger pan.
    let pinchStartDist = null;
    stage.on('touchmove', (e) => {
      if (e.evt.touches.length !== 2) return;
      e.evt.preventDefault();
      stage.stopDrag();
      const [t1, t2] = e.evt.touches;
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const center = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
      const rect = containerEl.getBoundingClientRect();
      const screenPoint = { x: center.x - rect.left, y: center.y - rect.top };
      if (pinchStartDist) zoomAround(screenPoint, (stage.scaleX() / worldScale) * (dist / pinchStartDist));
      pinchStartDist = dist;
    });
    stage.on('touchend', () => {
      pinchStartDist = null;
    });

    // Re-measure the container and re-fit the board to it. Safe to call
    // repeatedly (window resize) or once the container's real size becomes
    // known (screen just shown) — a no-op if the container is still 0-sized.
    function resize() {
      const w = containerEl.clientWidth;
      const h = containerEl.clientHeight;
      if (!w || !h) return;
      stage.width(w);
      stage.height(h);
      worldScale = w / BOARD_W;
      stage.scale({ x: worldScale, y: worldScale });
      stage.position(centeredPos(worldScale));
      updateControls();
      layer.batchDraw();
    }
    window.addEventListener('resize', resize);

    const meta = { stage, layer, resize };
    battlefieldStages.set(ownerId, meta);
    return meta;
  }

  // Re-fits every known battlefield (yours + all opponents') to its
  // container's current size. Called once the table screen actually becomes
  // visible, since stages created while it was hidden only got a fallback
  // size (see createBattlefieldStage).
  function resizeAllBattlefields() {
    battlefieldStages.forEach((meta) => meta.resize());
  }

  // Builds one card as a Konva.Group: art (or a face-down/token placeholder),
  // counter badges, tap rotation, and click/dblclick/tap/dbltap/contextmenu
  // handling equivalent to the old DOM version. Only your own cards drag or
  // tap — anyone can still right-click any card for other bookkeeping
  // actions (counters, transform, moving zones), same as before.
  //
  // Card nodes are persistent across renders (see renderBattlefieldLayer
  // below) — built once per card uid, then patched in place. That's why the
  // event handlers below read fresh data off the node itself
  // (group.getAttr('cardData')) instead of closing over the `card` argument:
  // once a node starts being reused across renders, that argument goes
  // stale (e.g. a right-click would show an outdated tapped/counters state).
  function buildCardNode(card, ownerId, isSelf) {
    const group = new Konva.Group({
      x: card.x,
      y: card.y,
      offsetX: CARD_W / 2,
      offsetY: CARD_H / 2,
      rotation: card.tapped ? 90 : 0,
      draggable: isSelf,
    });
    group.setAttr('cardData', card);
    group.clipFunc((ctx) => roundedRectPath(ctx, CARD_W, CARD_H, 6));

    const bg = new Konva.Rect({ width: CARD_W, height: CARD_H, fill: '#21262d', stroke: '#30363d', strokeWidth: 1 });
    group.add(bg);

    if (card.faceDown) {
      bg.fillLinearGradientStartPoint({ x: 0, y: 0 });
      bg.fillLinearGradientEndPoint({ x: CARD_W, y: CARD_H });
      bg.fillLinearGradientColorStops([0, '#30363d', 1, '#161b22']);
    } else {
      // Always draw a name/P-T text label as a base layer — previously a
      // card with no image URL (or art that was still loading) showed
      // nothing at all but the plain background, an unlabeled blank
      // rectangle with no way to tell what it even was. This is what a
      // Scryfall lookup that came back without an image_uris entry for one
      // specific card looked like: no console warning either, since
      // loadCardImage's `if (!url) return` bails out silently before
      // attempting anything. Now that gap always shows the card's name
      // instead, and it also doubles as a "loading…" placeholder for art
      // that hasn't attached yet.
      const label = new Konva.Text({
        text: card.name + (card.power != null ? `\n${card.power}/${card.toughness}` : ''),
        width: CARD_W,
        height: CARD_H,
        align: 'center',
        verticalAlign: 'middle',
        fontSize: 11,
        fill: '#e6e6e6',
        padding: 6,
        wrap: 'word',
      });
      group.add(label);

      if (card.image) {
        loadCardImage(card.image, (img) => {
          // The node may have been explicitly torn down by the time the
          // image finishes loading (see renderBattlefieldLayer, which sets
          // this flag right before calling destroy()). We used to check
          // group.getLayer() instead — Konva 9 has no isDestroyed() method
          // (calling it threw "group.isDestroyed is not a function", which
          // silently killed card art and, once cached, crashed the render
          // loop outright) — but getLayer() has its own bug: when a second
          // copy of a duplicate card (same art, e.g. two Islands) reuses an
          // already-cached image, this callback fires *synchronously* while
          // buildCardNode is still constructing the node, before
          // renderBattlefieldLayer has attached it to the layer — so
          // getLayer() was still null even though the node was perfectly
          // fine, and the art silently never attached. An explicit
          // 'removed' flag distinguishes "not attached yet" from
          // "destroyed" correctly.
          if (group.getAttr('removed')) return;
          label.destroy();
          group.add(new Konva.Image({ image: img, width: CARD_W, height: CARD_H }));
          bg.moveToBottom();
          const l = group.getLayer();
          if (l) l.batchDraw(); // no-op to skip here; renderBattlefieldLayer's own batchDraw() will cover the not-yet-attached case
        });
      } else {
        console.warn('No image URL for card — showing name label instead:', card.name, card);
      }
    }

    syncCounterBadges(group, card);

    // Single click/tap => enlarge for reading. Double click/tap => tap/untap.
    // The single click is delayed briefly so a double click doesn't also pop the preview.
    let clickTimer = null;
    group.on('click tap', (e) => {
      // Konva's 'click' fires for any mouse button by default, not just the
      // left one — so a right-click was triggering this (popping the card
      // preview open) *at the same time* as the browser's native
      // 'contextmenu' event opened the context menu, with the preview's
      // full-screen overlay sitting on top and blocking the menu entirely.
      // e.evt.button is only meaningful for real mouse events (touch/'tap'
      // has no .button property, so this correctly leaves touches alone).
      if (e.evt && typeof e.evt.button === 'number' && e.evt.button !== 0) return;
      e.cancelBubble = true;
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
        return;
      }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        openCardPreview(group.getAttr('cardData'), 'battlefield', ownerId);
      }, 220);
    });
    group.on('dblclick dbltap', (e) => {
      e.cancelBubble = true;
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      if (!isSelf) return; // only your own cards can be tapped
      socket.emit('tap_card', { ownerId, uid: card.uid });
    });
    group.on('contextmenu', (e) => {
      e.evt.preventDefault();
      openContextMenu(e.evt.clientX, e.evt.clientY, { uid: card.uid, ownerId, zone: 'battlefield', card: group.getAttr('cardData') });
    });

    if (isSelf) {
      group.on('dragend', () => {
        // group.getAttr('cardData') rather than the closure's `card` — this
        // handler is set up once when the node is first created, but the
        // node is patched in place on later renders, so the closure's `card`
        // can be stale (e.g. tapped after creation, then dragged).
        const isTapped = !!group.getAttr('cardData').tapped;
        const { x, y } = snapPosition(ownerId, card.uid, group.x(), group.y(), isTapped);
        group.position({ x, y });
        socket.emit('move_card', { uid: card.uid, ownerId, fromZone: 'battlefield', toZone: 'battlefield', x, y });
      });
    }

    return group;
  }

  // Clears and redraws just the counter badges on a card group — cheap
  // enough to always rebuild rather than diff individual counters.
  function syncCounterBadges(group, card) {
    group.find('.counterBadge').forEach((n) => n.destroy());
    Object.keys(card.counters || {}).forEach((key, i) => {
      const badge = new Konva.Group({ x: CARD_W - 11 - i * 18, y: CARD_H - 11, name: 'counterBadge' });
      badge.add(new Konva.Circle({ radius: 9, fill: '#8957e5' }));
      badge.add(
        new Konva.Text({
          text: String(card.counters[key]),
          fontSize: 10,
          fontStyle: 'bold',
          fill: 'white',
          width: 18,
          height: 18,
          offsetX: 9,
          offsetY: 9,
          align: 'center',
          verticalAlign: 'middle',
        })
      );
      group.add(badge);
    });
  }

  // A card's identity for rebuild purposes — if any of these change (flipped
  // face down/up, art/name differs — shouldn't happen for a fixed uid but
  // cheap to guard) the node is destroyed and rebuilt from scratch instead
  // of patched, since those affect which visual branch above was taken.
  function cardIdentity(card) {
    return [card.image || '', card.faceDown ? 1 : 0, card.isToken ? 1 : 0, card.transformed ? 1 : 0, card.name, card.power, card.toughness].join('|');
  }

  // Renders a field's cards as persistent per-uid Konva nodes, patched in
  // place, instead of tearing everything down and rebuilding it on every
  // single state update. Two real bugs came from the old destroy-everything
  // approach: (1) card art loads asynchronously, so destroying a node mid-
  // load meant the image could permanently fail to attach if another render
  // arrived first — cards stayed blank forever; (2) once an image *was*
  // cached, loading it again fires synchronously, so if building a card threw
  // partway through this loop, layer.batchDraw() never ran and nothing after
  // the failure got re-added — the whole board went blank and stayed that
  // way, since the same crash repeated on every subsequent render. Each
  // card is now wrapped in try/catch so one bad card can't take the rest
  // down with it.
  function renderBattlefieldLayer(layer, cards, ownerId, isSelf) {
    const nodes = layer.__cardNodes || (layer.__cardNodes = new Map()); // uid -> Konva.Group
    const seen = new Set();

    cards.forEach((card) => {
      seen.add(card.uid);
      const identity = cardIdentity(card);
      let node = nodes.get(card.uid);

      if (node && node.getAttr('cardIdentity') !== identity) {
        node.setAttr('removed', true); // see the loadCardImage callback in buildCardNode for why this matters
        node.destroy();
        nodes.delete(card.uid);
        node = null;
      }

      if (!node) {
        try {
          node = buildCardNode(card, ownerId, isSelf);
          node.setAttr('cardIdentity', identity);
          layer.add(node);
          nodes.set(card.uid, node);
        } catch (err) {
          console.error('Failed to build battlefield card node for', card, err);
        }
        return;
      }

      // Lightweight update: don't yank position out from under an
      // in-progress local drag.
      node.setAttr('cardData', card);
      if (!node.isDragging()) node.position({ x: card.x, y: card.y });
      node.rotation(card.tapped ? 90 : 0);
      syncCounterBadges(node, card);
    });

    for (const [uid, node] of nodes) {
      if (!seen.has(uid)) {
        node.setAttr('removed', true);
        node.destroy();
        nodes.delete(uid);
      }
    }

    layer.batchDraw();
  }

  // -------------------------------------------------------------------------
  // Screen management
  // -------------------------------------------------------------------------
  const screens = {
    landing: document.getElementById('screen-landing'),
    deck: document.getElementById('screen-deck'),
    table: document.getElementById('screen-table'),
  };
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
    if (name === 'table') {
      // The battlefield containers were 0-sized while this screen was
      // hidden (display:none), so any Konva stage created before now only
      // got a fallback size. requestAnimationFrame waits one frame so the
      // browser has actually applied the layout change before we measure it.
      requestAnimationFrame(resizeAllBattlefields);
    }
  }

  // -------------------------------------------------------------------------
  // Landing screen
  // -------------------------------------------------------------------------
  const inputName = document.getElementById('input-name');
  const inputCode = document.getElementById('input-code');
  const landingError = document.getElementById('landing-error');

  inputName.value = localStorage.getItem('mtg_name') || '';

  document.getElementById('btn-create').addEventListener('click', () => {
    const name = inputName.value.trim();
    if (!name) return (landingError.textContent = 'Enter your name first.');
    socket.emit('create_room', { name, playerId }, (res) => {
      if (!res.ok) return (landingError.textContent = res.error || 'Could not create table.');
      localStorage.setItem('mtg_name', name);
      joinRoom(res.code, name);
    });
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim().toUpperCase();
    if (!name) return (landingError.textContent = 'Enter your name first.');
    if (!code) return (landingError.textContent = 'Enter a table code.');
    localStorage.setItem('mtg_name', name);
    joinRoom(code, name);
  });

  function joinRoom(code, name) {
    socket.emit('join_room', { code, name, playerId }, (res) => {
      if (!res.ok) return (landingError.textContent = res.error || 'Could not join table.');
      currentCode = res.code;
      localStorage.setItem('mtg_code', currentCode);
      document.getElementById('deck-room-code').textContent = currentCode;
      showScreen('deck');
    });
  }

  // ---------------------------------------------------------------------
  // DEV ONLY — quick join list. Shows every in-memory table on the server
  // so you can hop in during testing without typing/copying a code. Remove
  // this block (and the matching server 'list_tables' handler + HTML) before
  // any real deployment — it leaks table codes and player names.
  // ---------------------------------------------------------------------
  function refreshTableList() {
    socket.emit('list_tables', {}, (res) => {
      const list = document.getElementById('table-list');
      if (!res || !res.ok || !res.tables.length) {
        list.innerHTML = '<div class="table-list-empty">No active tables right now.</div>';
        return;
      }
      list.innerHTML = '';
      res.tables.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'table-list-item';
        const names = t.players.length
          ? t.players.map((p) => p.name + (p.connected ? '' : ' (off)')).join(', ')
          : 'empty';
        let status = '';
        if (t.pinned) {
          status = '📌 pinned';
        } else if (t.removeInSeconds != null) {
          const m = Math.floor(t.removeInSeconds / 60);
          const s = t.removeInSeconds % 60;
          status = `removed in ${m}m ${s}s`;
        }
        row.innerHTML = `<span class="code">${escapeHtml(t.code)}</span><span class="names">${escapeHtml(names)}</span><span class="table-status">${escapeHtml(status)}</span>`;
        row.addEventListener('click', () => {
          const name = inputName.value.trim();
          if (!name) {
            landingError.textContent = 'Enter your name first.';
            return;
          }
          localStorage.setItem('mtg_name', name);
          joinRoom(t.code, name);
        });
        list.appendChild(row);
      });
    });
  }
  document.getElementById('btn-refresh-tables').addEventListener('click', refreshTableList);
  refreshTableList();
  setInterval(refreshTableList, 10000); // keep the removal countdown roughly live

  // Attempt silent auto-rejoin if we have a stored session — both on the
  // very first connection (e.g. page refresh mid-game) AND on every
  // reconnect. Socket.IO's client auto-reconnects after a dropped
  // connection (WiFi blip, laptop sleep, a backgrounded tab getting
  // throttled), but each reconnect gets a brand-new socket on the server
  // with no memory of which room/player it was — without re-emitting
  // join_room here, the page would keep rendering whatever state it last
  // received and silently stop updating, with no visible error, until the
  // user manually refreshes. Binding this to 'connect' (which fires for
  // both cases) instead of running once at script load closes that gap.
  socket.on('connect', () => {
    const code = currentCode || localStorage.getItem('mtg_code');
    const name = inputName.value.trim() || localStorage.getItem('mtg_name');
    if (!code || !name) return;
    socket.emit('join_room', { code, name, playerId }, (res) => {
      if (res && res.ok) {
        currentCode = res.code;
        showScreen('table');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Deck import screen
  // -------------------------------------------------------------------------
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard && navigator.clipboard.writeText(currentCode);
  });

  document.getElementById('btn-skip-deck').addEventListener('click', () => {
    showScreen('table');
  });

  // -------------------------------------------------------------------------
  // Random sample decks — mono-colored 60-card lists so you don't have to
  // type one out just to test the table.
  // -------------------------------------------------------------------------
  const SAMPLE_DECKS = {
    White: `4 Savannah Lions
4 Thraben Inspector
4 Adanto Vanguard
4 Healer's Hawk
4 Path to Exile
4 Swords to Plowshares
4 Giant Killer
4 Ajani's Pridemate
4 History of Benalia
2 Elspeth, Sun's Champion
22 Plains`,
    Blue: `4 Delver of Secrets
4 Brineborn Cutthroat
4 Spectral Sailor
4 Merfolk Trickster
4 Curious Obsession
4 Unsummon
4 Counterspell
4 Essence Scatter
4 Curator of Mysteries
2 Talrand, Sky Summoner
22 Island`,
    Black: `4 Knight of the Ebon Legion
4 Bloodsoaked Champion
4 Vampire Nighthawk
4 Fatal Push
4 Doom Blade
4 Dark Ritual
4 Duress
4 Reassembling Skeleton
4 Gray Merchant of Asphodel
2 Liliana, the Last Hope
22 Swamp`,
    Red: `4 Goblin Guide
4 Monastery Swiftspear
4 Lightning Bolt
4 Lava Spike
4 Rift Bolt
4 Lightning Strike
4 Eidolon of the Great Revel
4 Skewer the Critics
4 Searing Blaze
2 Exquisite Firecraft
22 Mountain`,
    Green: `4 Llanowar Elves
4 Elvish Mystic
4 Steel Leaf Champion
4 Scavenging Ooze
4 Vine Trellis
3 Ghalta, Primal Hunger
4 Tireless Tracker
4 Beast Within
3 Vivien, Champion of the Wilds
22 Forest`,
  };

  document.getElementById('btn-random-deck').addEventListener('click', () => {
    const colors = Object.keys(SAMPLE_DECKS);
    const color = colors[Math.floor(Math.random() * colors.length)];
    document.getElementById('input-decklist').value = SAMPLE_DECKS[color];
    document.getElementById('deck-status').textContent = `Loaded a random ${color} sample deck — edit it or hit Import.`;
  });

  // A deck of nothing but double-faced cards, for testing the Transform
  // context-menu action — a mix of classic "transform" layout cards
  // (Innistrad werewolves/vampires/etc, front/back are two full card faces)
  // and modern "modal_dfc" cards (Zendikar Rising's land-or-spell cards),
  // so both layout variants get exercised.
  const TRANSFORM_TEST_DECK = `1 Delver of Secrets
1 Huntmaster of the Fells
1 Thing in the Ice
1 Jace, Vryn's Prodigy
1 Search for Azcanta
1 Arlinn Kord
1 Garruk Relentless
1 Nissa, Vastwood Seer
1 Liliana, Heretical Healer
1 Bloodline Keeper
1 Kytheon, Hero of Akros
1 Legion's Landing
1 Growing Rites of Itlimoc
1 Kruin Outlaw
1 Docent of Perfection
1 Emeria's Call
1 Glasspool Mimic
1 Valakut Awakening
1 Chandra, Fire of Kaladesh
10 Island`;

  document.getElementById('btn-transform-deck').addEventListener('click', () => {
    document.getElementById('input-decklist').value = TRANSFORM_TEST_DECK;
    document.getElementById('deck-status').textContent = 'Loaded a test deck of double-faced cards — edit it or hit Import.';
  });

  document.getElementById('btn-import').addEventListener('click', async () => {
    const text = document.getElementById('input-decklist').value;
    const status = document.getElementById('deck-status');
    const parsed = parseDecklist(text);
    if (parsed.size === 0) {
      status.textContent = 'No cards found — paste a decklist first, or use "Skip".';
      return;
    }
    status.textContent = 'Looking up cards…';
    try {
      const { cards, notFound } = await resolveDeck(parsed);
      if (notFound.length) {
        status.textContent = `Imported. Could not find: ${notFound.join(', ')}`;
      } else {
        status.textContent = `Imported ${cards.length} cards.`;
      }
      socket.emit('set_library', { cards }, (res) => {
        if (res && res.ok) showScreen('table');
      });
    } catch (err) {
      console.error(err);
      status.textContent = 'Error looking up cards: ' + err.message;
    }
  });

  function parseDecklist(text) {
    const map = new Map(); // name -> qty
    text.split('\n').forEach((raw) => {
      let line = raw.trim();
      if (!line || line.startsWith('//') || /^(deck|sideboard|maybeboard)\s*:?$/i.test(line)) return;
      const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
      let qty = 1;
      let name = line;
      if (m) {
        qty = parseInt(m[1], 10);
        name = m[2];
      }
      name = name.replace(/\(.*?\)/g, '').replace(/\s+\d+\s*$/, '').replace(/[*].*$/, '').trim();
      if (!name) return;
      const key = name;
      map.set(key, (map.get(key) || 0) + qty);
    });
    return map;
  }

  // Card lookup now happens server-side (see server.js's 'resolve_deck'
  // handler): a local SQLite snapshot built from a Scryfall bulk-data dump
  // first (instant, offline), live Scryfall API as a fallback for anything
  // not found there. The server also already routes returned images through
  // its own /card-art cache, so the card objects it hands back are ready to
  // use as-is — no client-side Scryfall fetch or image-URL rewriting needed
  // here anymore.
  function resolveDeck(nameQtyMap) {
    const names = [...nameQtyMap.keys()];
    return new Promise((resolve, reject) => {
      socket.emit('resolve_deck', { names }, (res) => {
        if (!res || !res.ok) {
          reject(new Error((res && res.error) || 'Card lookup failed.'));
          return;
        }
        const cards = [];
        const notFound = [...res.notFound];
        for (const [name, qty] of nameQtyMap.entries()) {
          const card = res.resolved[name.toLowerCase()];
          if (!card) {
            if (!notFound.includes(name)) notFound.push(name);
            continue;
          }
          for (let i = 0; i < qty; i++) cards.push(card);
        }
        resolve({ cards, notFound });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Table screen — rendering
  // -------------------------------------------------------------------------
  const opponentsArea = document.getElementById('opponents-area');
  const selfBattlefield = document.getElementById('self-battlefield');
  const selfHand = document.getElementById('self-hand');
  const chatLog = document.getElementById('chat-log');

  selfBattlefield.dataset.owner = playerId;
  const selfStageMeta = createBattlefieldStage(
    selfBattlefield,
    playerId,
    document.getElementById('self-zoom-slider'),
    document.getElementById('self-zoom-label')
  );

  socket.on('state', (state) => {
    latestState = state;
    render(state);
  });

  function cardStyleAttrs(card) {
    const showFace = !card.faceDown;
    const bg = showFace && card.image ? `background-image:url('${card.image}')` : '';
    return bg;
  }

  // Hand cards are the only ones still rendered as plain DOM elements (the
  // battlefield moved to Konva, above) — they're always your own, always
  // face-up-to-you, and never tapped/countered, so this is much simpler than
  // the old shared version.
  function renderHandCardEl(card, ownerId) {
    const el = document.createElement('div');
    el.className = 'card' + (card.isToken && !card.image ? ' token' : '');
    el.style = cardStyleAttrs(card);
    el.dataset.uid = card.uid;
    el.dataset.owner = ownerId;
    el.dataset.zone = 'hand';
    el.title = `${card.name}${card.typeLine ? ' — ' + card.typeLine : ''}`;

    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ uid: card.uid, ownerId, fromZone: 'hand' }));
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, { uid: card.uid, ownerId, zone: 'hand', card });
    });
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardPreview(card, 'hand', ownerId);
    });
    return el;
  }

  // -------------------------------------------------------------------------
  // Card preview (click to enlarge)
  // -------------------------------------------------------------------------
  const previewOverlay = document.getElementById('card-preview-overlay');
  const previewImg = document.getElementById('card-preview-img');
  const previewFallback = document.getElementById('card-preview-fallback');
  const previewBoth = document.getElementById('card-preview-both');
  const previewFrontImg = document.getElementById('card-preview-front-img');
  const previewBackImg = document.getElementById('card-preview-back-img');
  const previewRulingsPanel = document.getElementById('card-preview-rulings');
  const previewRulingsBtn = document.getElementById('card-preview-rulings-btn');
  const previewRulingsList = document.getElementById('card-preview-rulings-list');
  const previewActions = document.getElementById('card-preview-actions');

  // Rulings live inside the overlay (so they sit right below the enlarged
  // card), but the overlay itself closes the preview on any click — stop
  // that click from bubbling up when it's actually aimed at the rulings
  // panel/button/list.
  previewRulingsPanel.addEventListener('click', (e) => e.stopPropagation());
  previewActions.addEventListener('click', (e) => e.stopPropagation());
  previewRulingsBtn.addEventListener('click', () => {
    const oracleId = previewRulingsBtn.dataset.oracleId;
    if (!oracleId) return;
    previewRulingsBtn.disabled = true;
    previewRulingsBtn.textContent = 'Loading…';
    socket.emit('get_rulings', { oracleId }, (res) => {
      previewRulingsBtn.classList.add('hidden');
      previewRulingsList.classList.remove('hidden');
      const rulings = (res && res.ok && res.rulings) || [];
      previewRulingsList.innerHTML = rulings.length
        ? rulings
            .map((r) => `<div class="ruling-entry"><span class="ruling-date">${escapeHtml(r.published_at || '')}</span>${escapeHtml(r.comment)}</div>`)
            .join('')
        : '<div class="rulings-empty">No official rulings found for this card.</div>';
    });
  });

  // `zone` controls the "show both sides" behavior below — only relevant in
  // hand, where you're deciding what to do with a double-faced card before
  // it's committed to a zone. On the battlefield the single current face is
  // what matters (and Transform is right there in the context menu), so
  // that case still shows just the one image, same as before.
  function openCardPreview(card, zone, ownerId) {
    previewImg.classList.add('hidden');
    previewFallback.classList.add('hidden');
    previewBoth.classList.add('hidden');

    // Quick "move to..." buttons, same destinations as the right-click menu —
    // handy for exactly this moment, when you're already looking a card over
    // and decide it needs to go to the battlefield/hand/graveyard/exile.
    previewActions.innerHTML = '';
    if (ownerId) {
      ZONE_MOVE_LABELS.forEach(([z, label]) => {
        if (z === zone) return;
        const btn = document.createElement('button');
        btn.className = 'btn tiny';
        btn.textContent = label;
        btn.addEventListener('click', () => {
          socket.emit('move_card', { uid: card.uid, ownerId, fromZone: zone, toZone: z });
          previewOverlay.classList.add('hidden');
        });
        previewActions.appendChild(btn);
      });
      previewActions.classList.remove('hidden');
    } else {
      previewActions.classList.add('hidden');
    }

    // Reset the rulings panel for whichever card is being shown now — a
    // card's own oracleId is shared across every printing and both faces
    // of a double-faced card, so this one id covers rulings for the whole
    // card regardless of which face/printing is currently up.
    previewRulingsBtn.textContent = 'View Rulings';
    previewRulingsBtn.disabled = false;
    previewRulingsBtn.classList.remove('hidden');
    previewRulingsList.classList.add('hidden');
    previewRulingsList.innerHTML = '';
    if (card.oracleId && !card.faceDown) {
      previewRulingsBtn.dataset.oracleId = card.oracleId;
      previewRulingsPanel.classList.remove('hidden');
    } else {
      previewRulingsPanel.classList.add('hidden');
    }

    if (zone === 'hand' && card.back && !card.faceDown) {
      // card.front/card.back are the permanent front/back data regardless of
      // the card's current transformed state — shown in their natural
      // physical order (front, then back) rather than "current face first".
      previewFrontImg.src = card.front.image;
      previewBackImg.src = card.back.image;
      previewBoth.classList.remove('hidden');
    } else if (!card.faceDown && card.image) {
      previewImg.src = card.image;
      previewImg.classList.remove('hidden');
    } else {
      previewFallback.classList.remove('hidden');
      if (card.faceDown) {
        previewFallback.innerHTML = '<div class="preview-name">Face-down card</div>';
      } else {
        previewFallback.innerHTML = `
          <div class="preview-name">${escapeHtml(card.name)}</div>
          ${card.typeLine ? `<div class="preview-type">${escapeHtml(card.typeLine)}</div>` : ''}
          ${card.power != null ? `<div class="preview-pt">${escapeHtml(String(card.power))}/${escapeHtml(String(card.toughness))}</div>` : ''}
        `;
      }
    }
    previewOverlay.classList.remove('hidden');
  }
  previewOverlay.addEventListener('click', () => previewOverlay.classList.add('hidden'));

  // pid -> { block, header, bf, layer, piles } — built once per opponent,
  // then reused/updated every render. See the note in the render() opponents
  // section for why these are persistent instead of rebuilt each time.
  const opponentElements = new Map();

  function getOrCreateOpponentEls(pid) {
    if (opponentElements.has(pid)) return opponentElements.get(pid);

    const block = document.createElement('div');
    block.className = 'opponent-block';
    // Attach immediately, before creating the Konva stage below — Konva reads
    // the container's actual pixel size at construction time, so the element
    // needs to already be in the document (same reason self's battlefield
    // needs resizeAllBattlefields() when the table screen becomes visible).
    opponentsArea.appendChild(block);

    const header = document.createElement('div');
    header.className = 'opponent-header';
    block.appendChild(header);

    const bf = document.createElement('div');
    bf.className = 'opponent-battlefield dropzone';
    bf.dataset.zone = 'battlefield';
    bf.dataset.owner = pid;
    block.appendChild(bf);

    const zoomControl = document.createElement('div');
    zoomControl.className = 'zoom-control';
    zoomControl.innerHTML = `
      <span class="zoom-icon">−</span>
      <input type="range" min="${ZOOM_MIN}" max="${ZOOM_MAX}" step="0.05" value="1" />
      <span class="zoom-icon">+</span>
      <span class="zoom-label">100%</span>
    `;

    const { layer } = createBattlefieldStage(bf, pid, zoomControl.querySelector('input'), zoomControl.querySelector('.zoom-label'));
    bf.appendChild(zoomControl); // on top of the Konva canvas Konva just injected
    attachDropzone(bf);

    const piles = document.createElement('div');
    piles.className = 'opponent-piles';
    // Delegated listener set up once — the innerHTML below is rewritten every
    // render, so binding to individual spans would mean re-attaching constantly.
    piles.addEventListener('click', (e) => {
      const zone = e.target.dataset.pileZone;
      if (zone) openPileModal(pid, zone);
    });
    block.appendChild(piles);

    const els = { block, header, bf, layer, piles };
    opponentElements.set(pid, els);
    return els;
  }

  function render(state) {
    const you = state.players[state.you];
    if (!you) return;

    document.getElementById('table-room-code').textContent = `Table: ${state.code}`;

    const pinBtn = document.getElementById('btn-pin');
    pinBtn.textContent = state.pinned ? '📌 Pinned' : '📌 Keep Table Alive';
    pinBtn.classList.toggle('active', !!state.pinned);

    // --- self stats ---
    document.getElementById('self-life').textContent = you.life;
    document.getElementById('self-poison').textContent = you.poison;
    document.getElementById('library-count').textContent = you.libraryCount;
    document.getElementById('graveyard-count').textContent = you.graveyard.length;
    document.getElementById('exile-count').textContent = you.exile.length;

    // --- self battlefield ---
    renderBattlefieldLayer(selfStageMeta.layer, you.battlefield, state.you, true);

    // --- self hand ---
    selfHand.innerHTML = '';
    you.hand.forEach((card) => selfHand.appendChild(renderHandCardEl(card, state.you)));

    // --- opponents ---
    // Each opponent gets a persistent set of DOM elements (built once, then
    // updated in place) rather than being torn down and recreated every
    // render. That's what lets a slider drag, pan drag, or pinch-in-progress
    // survive an unrelated state update (e.g. someone else drawing a card)
    // instead of getting yanked out from under the interaction, and it keeps
    // the zoom/pan event listeners from piling up on every render.
    const liveOpponentIds = new Set(state.playerOrder.filter((pid) => pid !== state.you));
    for (const pid of [...opponentElements.keys()]) {
      if (!liveOpponentIds.has(pid)) {
        battlefieldStages.get(pid)?.stage.destroy();
        battlefieldStages.delete(pid);
        opponentElements.get(pid).block.remove();
        opponentElements.delete(pid);
      }
    }
    state.playerOrder.filter((pid) => pid !== state.you).forEach((pid) => {
      const p = state.players[pid];
      if (!p) return;
      const els = getOrCreateOpponentEls(pid);

      els.header.innerHTML = `
        <span class="name">${escapeHtml(p.name)}</span>
        <span class="stat">❤ ${p.life}</span>
        <span class="stat">☠ ${p.poison}</span>
        <span class="stat ${p.connected ? '' : 'disconnected'}">${p.connected ? 'online' : 'offline'}</span>
      `;

      renderBattlefieldLayer(els.layer, p.battlefield, pid, false);

      els.piles.innerHTML = `
        <span class="pile-mini">Library: ${p.libraryCount}</span>
        <span class="pile-mini">Hand: ${p.handCount}</span>
        <span class="pile-mini pile-mini-clickable" data-pile-zone="graveyard">Graveyard: ${p.graveyard.length}</span>
        <span class="pile-mini pile-mini-clickable" data-pile-zone="exile">Exile: ${p.exile.length}</span>
      `;

      // Re-appending an already-attached node just moves it — keeps DOM order
      // matching playerOrder without recreating anything.
      opponentsArea.appendChild(els.block);
    });

    // --- chat log ---
    const wasAtBottom = chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 20;
    chatLog.innerHTML = state.log.map((e) => `<div class="entry"><span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>${escapeHtml(e.text)}</div>`).join('');
    if (wasAtBottom) chatLog.scrollTop = chatLog.scrollHeight;

    // --- pile viewer, if open ---
    // Someone else's action (or your own move from the modal itself) can
    // change the pile you're currently browsing — keep it in sync live
    // instead of showing a stale list until you close and reopen it.
    renderPileModalContents();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // -------------------------------------------------------------------------
  // Drag and drop
  // -------------------------------------------------------------------------
  function attachDropzone(el) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('dragover');
      let data;
      try {
        data = JSON.parse(e.dataTransfer.getData('text/plain'));
      } catch {
        return;
      }
      const toZone = el.dataset.zone;
      const payload = { uid: data.uid, ownerId: data.ownerId, fromZone: data.fromZone, toZone };
      if (toZone === 'battlefield') {
        // Hand cards are still plain DOM drag-and-drop; the battlefield they're
        // dropped onto is a Konva Stage. Convert the drop's screen position
        // into that stage's board-space coordinates (undoing its current
        // pan/zoom), then clamp so the card's full footprint (using the
        // larger of its two dimensions, since tapping rotates it) stays
        // inside the board.
        const meta = battlefieldStages.get(el.dataset.owner);
        if (meta) {
          const rect = el.getBoundingClientRect();
          const scale = meta.stage.scaleX();
          const localX = (e.clientX - rect.left - meta.stage.x()) / scale;
          const localY = (e.clientY - rect.top - meta.stage.y()) / scale;
          const snapped = snapPosition(payload.ownerId, payload.uid, localX, localY);
          payload.x = snapped.x;
          payload.y = snapped.y;
        } else {
          payload.x = BOARD_W / 2;
          payload.y = BOARD_H / 2;
        }
      }
      socket.emit('move_card', payload);
    });
  }
  document.querySelectorAll('.dropzone').forEach(attachDropzone);

  // -------------------------------------------------------------------------
  // Graveyard / Exile pile viewer
  // -------------------------------------------------------------------------
  // Graveyard and exile are public zones — the server already sends every
  // player's full card list for both (see viewFor() in server.js), so this
  // works identically for your own piles and any opponent's. That's also why
  // move_card is happy to relocate a card in someone else's graveyard/exile:
  // it's meant for shared bookkeeping, not just your own zones.
  const pileModal = document.getElementById('pile-modal');
  const pileModalTitle = document.getElementById('pile-modal-title');
  const pileModalList = document.getElementById('pile-modal-list');
  let openPile = null; // { ownerId, zone } while the modal is open, else null

  function renderPileCardEl(card, ownerId, zone) {
    // A card can technically reach the graveyard/exile still marked
    // faceDown (e.g. a face-down battlefield permanent that died) — unlike
    // the battlefield's Konva rendering, this list has no separate
    // "face-down back" art, so hide the name/art rather than leak it.
    const hidden = !!card.faceDown;

    const wrap = document.createElement('div');
    wrap.className = 'pile-card-wrap';

    const el = document.createElement('div');
    el.className = 'card' + (card.isToken && !card.image ? ' token' : '') + (hidden ? ' facedown' : '');
    el.style = hidden ? '' : cardStyleAttrs(card);
    el.title = hidden ? 'Face-down card' : `${card.name}${card.typeLine ? ' — ' + card.typeLine : ''}`;
    el.addEventListener('click', () => openCardPreview(card, zone, ownerId));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, { uid: card.uid, ownerId, zone, card });
    });
    wrap.appendChild(el);

    const name = document.createElement('div');
    name.className = 'pile-card-name';
    name.textContent = hidden ? 'Face-down card' : card.name;
    wrap.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'pile-card-actions';
    const moveTo = (toZone, label) => {
      const btn = document.createElement('button');
      btn.className = 'btn tiny';
      btn.textContent = label;
      btn.addEventListener('click', () => socket.emit('move_card', { uid: card.uid, ownerId, fromZone: zone, toZone }));
      actions.appendChild(btn);
    };
    moveTo('hand', '→ Hand');
    moveTo('battlefield', '→ Field');
    // Graveyard/exile swap the other way too (mill-into-exile, exiled cards
    // getting returned to the graveyard, etc.) — offer whichever of the two
    // isn't the pile currently being viewed.
    moveTo(zone === 'graveyard' ? 'exile' : 'graveyard', zone === 'graveyard' ? '→ Exile' : '→ Grave');
    wrap.appendChild(actions);

    return wrap;
  }

  function renderPileModalContents() {
    if (!openPile || !latestState) return;
    const { ownerId, zone } = openPile;
    const p = latestState.players[ownerId];
    if (!p) { closePileModal(); return; }

    const zoneLabel = zone === 'graveyard' ? 'Graveyard' : 'Exile';
    const whose = ownerId === latestState.you ? 'Your' : `${p.name}'s`;
    pileModalTitle.textContent = `${whose} ${zoneLabel} (${p[zone].length})`;

    pileModalList.innerHTML = '';
    if (p[zone].length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pile-modal-empty';
      empty.textContent = `${zoneLabel} is empty.`;
      pileModalList.appendChild(empty);
      return;
    }
    p[zone].forEach((card) => pileModalList.appendChild(renderPileCardEl(card, ownerId, zone)));
  }

  function openPileModal(ownerId, zone) {
    openPile = { ownerId, zone };
    renderPileModalContents();
    pileModal.classList.remove('hidden');
  }

  function closePileModal() {
    openPile = null;
    pileModal.classList.add('hidden');
  }

  document.getElementById('pile-modal-close').addEventListener('click', closePileModal);
  document.getElementById('pile-graveyard').addEventListener('click', () => openPileModal(playerId, 'graveyard'));
  document.getElementById('pile-exile').addEventListener('click', () => openPileModal(playerId, 'exile'));

  // Library pile click => draw 1
  document.getElementById('pile-library').addEventListener('click', (e) => {
    if (e.target.closest('.dropzone') === document.getElementById('pile-library')) {
      socket.emit('draw_card', { count: 1 });
    }
  });
  document.getElementById('btn-draw1').addEventListener('click', () => socket.emit('draw_card', { count: 1 }));
  document.getElementById('btn-shuffle').addEventListener('click', () => socket.emit('shuffle_library', {}));
  document.getElementById('btn-mulligan').addEventListener('click', () => socket.emit('mulligan_hand', {}));

  document.querySelectorAll('[data-life]').forEach((btn) => {
    btn.addEventListener('click', () => socket.emit('update_life', { delta: parseInt(btn.dataset.life, 10) }));
  });
  document.querySelectorAll('[data-poison]').forEach((btn) => {
    btn.addEventListener('click', () => socket.emit('update_poison', { delta: parseInt(btn.dataset.poison, 10) }));
  });

  // -------------------------------------------------------------------------
  // Token modal
  // -------------------------------------------------------------------------
  const tokenModal = document.getElementById('token-modal');
  document.getElementById('btn-token').addEventListener('click', () => tokenModal.classList.remove('hidden'));
  document.getElementById('token-cancel').addEventListener('click', () => tokenModal.classList.add('hidden'));
  document.getElementById('token-create').addEventListener('click', () => {
    const name = document.getElementById('token-name').value.trim() || 'Token';
    const power = document.getElementById('token-power').value.trim();
    const toughness = document.getElementById('token-toughness').value.trim();
    const color = document.getElementById('token-color').value.trim();
    socket.emit('create_token', {
      name,
      power: power === '' ? null : power,
      toughness: toughness === '' ? null : toughness,
      color,
    });
    document.getElementById('token-name').value = '';
    document.getElementById('token-power').value = '';
    document.getElementById('token-toughness').value = '';
    document.getElementById('token-color').value = '';
    tokenModal.classList.add('hidden');
  });

  // -------------------------------------------------------------------------
  // Context menu
  // -------------------------------------------------------------------------
  const contextMenu = document.getElementById('context-menu');
  document.addEventListener('click', () => contextMenu.classList.add('hidden'));

  function menuItem(label, onClick) {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = label;
    d.addEventListener('click', onClick);
    return d;
  }

  function openContextMenu(x, y, ctx) {
    const { uid, ownerId, zone, card } = ctx;
    contextMenu.innerHTML = '';

    if (card.back) {
      // card.front/card.back are fixed references to each side's data — they
      // don't swap when transformed, only the card's top-level displayed
      // fields do. So the face we'd switch TO is whichever one isn't
      // currently showing.
      const otherFace = card.transformed ? card.front : card.back;
      // Scryfall's `layout` tells us which of two different real mechanics
      // this is — the interface treats them differently:
      //  - modal_dfc ("play this or that", e.g. Emeria's Call): you pick a
      //    face at cast time, it never flips back mid-game. Offered in any
      //    zone, since the real choice is made in hand before playing it.
      //  - transform / double_faced_token (e.g. Delver of Secrets): a
      //    genuine flip that happens to a permanent already on the
      //    battlefield, so it's only offered there.
      const isModal = card.layout === 'modal_dfc';
      if (isModal || zone === 'battlefield') {
        contextMenu.appendChild(menuItem(isModal ? `Play as ${otherFace.name}` : `Transform into ${otherFace.name}`, () =>
          socket.emit('transform_card', { ownerId, uid })
        ));
        const divFace = document.createElement('div');
        divFace.className = 'divider';
        contextMenu.appendChild(divFace);
      }
    }

    if (zone === 'battlefield') {
      if (ownerId === playerId) {
        contextMenu.appendChild(menuItem(card.tapped ? 'Untap' : 'Tap', () => socket.emit('tap_card', { ownerId, uid })));
      }
      contextMenu.appendChild(menuItem(card.faceDown ? 'Turn face up' : 'Turn face down', () =>
        socket.emit('move_card', { uid, ownerId, fromZone: zone, toZone: zone, faceDown: !card.faceDown })
      ));
      const div = document.createElement('div');
      div.className = 'divider';
      contextMenu.appendChild(div);
      contextMenu.appendChild(menuItem('+1/+1 counter', () => socket.emit('set_counter', { ownerId, uid, key: '+1/+1', delta: 1 })));
      contextMenu.appendChild(menuItem('-1/-1 counter', () => socket.emit('set_counter', { ownerId, uid, key: '-1/-1', delta: 1 })));
      contextMenu.appendChild(menuItem('Remove a counter…', () => {
        const key = prompt('Which counter type to remove one of?', '+1/+1');
        if (key) socket.emit('set_counter', { ownerId, uid, key, delta: -1 });
      }));
      contextMenu.appendChild(menuItem('Add custom counter…', () => {
        const key = prompt('Counter name (e.g. loyalty, charge):', 'loyalty');
        if (key) socket.emit('set_counter', { ownerId, uid, key, delta: 1 });
      }));
      const div2 = document.createElement('div');
      div2.className = 'divider';
      contextMenu.appendChild(div2);
    }

    ZONE_MOVE_LABELS.forEach(([z, label]) => {
      if (z === zone) return;
      contextMenu.appendChild(menuItem(label, () => socket.emit('move_card', { uid, ownerId, fromZone: zone, toZone: z })));
    });

    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
    contextMenu.classList.remove('hidden');
  }

  // -------------------------------------------------------------------------
  // Pin table (keep alive indefinitely, bypassing the 15-min empty timeout)
  // -------------------------------------------------------------------------
  document.getElementById('btn-pin').addEventListener('click', () => {
    socket.emit('pin_table', {}, (res) => {
      if (res && !res.ok) alert(res.error);
    });
  });

  // -------------------------------------------------------------------------
  // Leave table
  // -------------------------------------------------------------------------
  document.getElementById('btn-leave').addEventListener('click', () => {
    socket.emit('leave_room', {});
    localStorage.removeItem('mtg_code');
    currentCode = null;
    latestState = null;
    landingError.textContent = '';
    inputCode.value = '';
    showScreen('landing');
  });

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------
  document.getElementById('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chat-input');
    if (input.value.trim()) {
      socket.emit('chat_message', { text: input.value });
      input.value = '';
    }
  });
})();
