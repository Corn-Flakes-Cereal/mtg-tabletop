/* global io */
(() => {
  const socket = io();

  function getOrCreatePlayerId() {
    let id = localStorage.getItem('mtg_rules_player_id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem('mtg_rules_player_id', id);
    }
    return id;
  }
  const playerId = getOrCreatePlayerId();

  let latestState = null;

  const screens = {
    landing: document.getElementById('screen-landing'),
    table: document.getElementById('screen-table'),
  };
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
  }

  const landingError = document.getElementById('landing-error');
  const inputName = document.getElementById('input-name');
  const inputCode = document.getElementById('input-code');

  const lastName = localStorage.getItem('mtg_rules_name');
  if (lastName) inputName.value = lastName;

  function joinOrCreate(code) {
    const name = inputName.value.trim() || 'Player';
    localStorage.setItem('mtg_rules_name', name);
    socket.emit('join_room', { code, name, playerId }, (res) => {
      if (!res || !res.ok) {
        landingError.textContent = (res && res.error) || 'Failed to join table.';
        return;
      }
      localStorage.setItem('mtg_rules_code', res.code);
      landingError.textContent = '';
      showScreen('table');
    });
  }

  document.getElementById('btn-create').addEventListener('click', () => {
    socket.emit('create_room', {}, (res) => {
      if (!res || !res.ok) {
        landingError.textContent = (res && res.error) || 'Failed to create table.';
        return;
      }
      joinOrCreate(res.code);
    });
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const code = inputCode.value.trim().toUpperCase();
    if (!code) {
      landingError.textContent = 'Enter a table code.';
      return;
    }
    joinOrCreate(code);
  });

  document.getElementById('btn-leave').addEventListener('click', () => {
    socket.emit('leave_room', {});
    localStorage.removeItem('mtg_rules_code');
    latestState = null;
    landingError.textContent = '';
    inputCode.value = '';
    showScreen('landing');
  });

  document.getElementById('btn-start').addEventListener('click', () => {
    socket.emit('start_game', {}, (res) => {
      if (res && !res.ok) alert(res.error);
    });
  });

  document.getElementById('btn-pass').addEventListener('click', () => {
    socket.emit('pass_priority', {}, (res) => {
      if (res && !res.ok) alert(res.error);
    });
  });

  const stackLabelInput = document.getElementById('input-stack-label');
  function submitStackItem() {
    const label = stackLabelInput.value.trim();
    if (!label) return;
    socket.emit('add_to_stack', { label }, (res) => {
      if (res && !res.ok) {
        alert(res.error);
        return;
      }
      stackLabelInput.value = '';
    });
  }
  document.getElementById('btn-add-stack').addEventListener('click', submitStackItem);
  stackLabelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitStackItem();
  });

  socket.on('state', (state) => {
    latestState = state;
    render(state);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render(state) {
    document.getElementById('table-room-code').textContent = `Table: ${state.code}`;

    // --- players ---
    const playerList = document.getElementById('player-list');
    playerList.innerHTML = state.playerOrder.map((pid) => {
      const p = state.players[pid];
      const isActive = pid === state.activePlayerId;
      const isPriority = pid === state.priorityPlayerId;
      const tags = [];
      if (isPriority) tags.push('<span class="tag priority">priority</span>');
      if (!p.connected) tags.push('<span class="tag disconnected">offline</span>');
      return `<div class="player-row${isActive ? ' active' : ''}">
        <span>${escapeHtml(p.name)}${pid === playerId ? ' (you)' : ''}${isActive ? ' — active' : ''}</span>
        <span>${tags.join(' ')}</span>
      </div>`;
    }).join('') || '<div class="subtle">No one here yet.</div>';

    // --- start button ---
    const startBtn = document.getElementById('btn-start');
    startBtn.classList.toggle('hidden', state.started);

    // --- turn / phase ---
    document.getElementById('turn-number').textContent = state.started ? `Turn ${state.turnNumber}` : 'Not started';
    document.getElementById('step-label').textContent = state.started
      ? `${state.players[state.activePlayerId]?.name || '?'}'s ${state.stepLabel}`
      : '';

    const priorityIndicator = document.getElementById('priority-indicator');
    const youHavePriority = state.started && state.priorityPlayerId === playerId;
    if (!state.started) {
      priorityIndicator.textContent = 'Waiting for the game to start.';
    } else if (youHavePriority) {
      priorityIndicator.textContent = 'You have priority.';
    } else {
      const holder = state.players[state.priorityPlayerId];
      priorityIndicator.textContent = `Waiting on ${holder ? holder.name : '?'} to act.`;
    }

    document.getElementById('btn-pass').disabled = !youHavePriority;
    document.getElementById('input-stack-label').disabled = !youHavePriority;
    document.getElementById('btn-add-stack').disabled = !youHavePriority;

    // --- stack --- (rendered bottom-to-top in the DOM via column-reverse CSS,
    // so just push in resolution order: index 0 = bottom of stack)
    const stackList = document.getElementById('stack-list');
    stackList.innerHTML = state.stack.length
      ? state.stack.map((obj) => `
          <div class="stack-item">
            <div>${escapeHtml(obj.label)}</div>
            <div class="controller">${escapeHtml(state.players[obj.controllerId]?.name || '?')}</div>
          </div>
        `).join('')
      : '<div class="stack-empty">Stack is empty.</div>';

    // --- log ---
    const gameLog = document.getElementById('game-log');
    gameLog.innerHTML = state.log.map((e) => `<div class="entry"><span class="ts">${new Date(e.ts).toLocaleTimeString()}</span>${escapeHtml(e.text)}</div>`).join('');
  }

  // Rejoin automatically if we were already at a table (page refresh).
  const savedCode = localStorage.getItem('mtg_rules_code');
  if (savedCode && inputName.value.trim()) {
    joinOrCreate(savedCode);
  } else {
    showScreen('landing');
  }
})();
