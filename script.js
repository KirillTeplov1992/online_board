(function() {
  // ========== КОНФИГУРАЦИЯ ==========
  const GRID_SIZE = 20;
  const RULER_LENGTH = 620;
  const RULER_THICKNESS = 90;
  const PENCIL_WIDTH = 4.5;
  const ERASER_RADIUS = 18;
  const TICK_STEP = 10;

  // ========== ХОЛСТ ==========
  const mainCanvas = document.getElementById('boardCanvas');
  const mainCtx = mainCanvas.getContext('2d');

  // ========== СОСТОЯНИЕ ==========
  let currentTool = 'pencil';       // 'pencil' | 'eraser' | 'hand'
  let rulerVisible = true;

  // Камера: мировые координаты (worldX, worldY) верхнего левого угла видимой области.
  // Экранная точка = мировая - camera.
  let cameraX = 0;
  let cameraY = 0;

  // Линейка — её центр хранится в МИРОВЫХ координатах
  let rulerAngle = 0;
  let rulerCenterX = 0;
  let rulerCenterY = 0;

  // Рисование в мировых координатах
  let isDrawing = false;
  let lastPencilX = null;
  let lastPencilY = null;

  let isErasing = false;

  // Перетаскивание линейки
  let isDraggingRuler = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  // Рука — панорамирование
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let panCameraStartX = 0;
  let panCameraStartY = 0;

  // Кэш видимых линий (по мировым координатам) — рисуем их оффскрин в большом мире
  // Но так как мир бесконечный, рисуем только то, что видно.
  // Для этого используем «большой» буфер растровых линий, который хранится в мировых
  // координатах, но для простоты и производительности будем хранить его тоже бесконечно.
  // На практике: используем один canvas, размер которого совпадает с окном, и
  // пересчитываем позиции всех линий при рендере. Это слишком дорого.
  //
  // Более простой и рабочий подход: рисование идёт прямо на "мировом" offscreen-canvas
  // ОГРОМНОГО размера, достаточного для большинства задач. Но это ограничивает мир.
  //
  // Компромисс: используем «чанковую» систему: разбиваем мир на квадраты и храним
  // отдельные offscreen-канвасы по чанкам. Слишком сложно для этого ответа.
  //
  // Практичное решение, которое мы реализуем: рисуем линии прямо в мировых координатах
  // на offscreen-канвасе, размер которого = размер окна, но со смещением камеры.
  // Для этого при каждом рендере пересобираем видимую часть: берём все нарисованные
  // отрезки из массива и рисуем их с учётом камеры.
  //
  // Это даёт настоящую бесконечную доску без ограничения по размеру.

  // Массив нарисованных линий (штрихов) в мировых координатах.
  // Каждая линия — { x1, y1, x2, y2 }.
  const strokes = [];

  // Аналогично для стирания — но стирание растровое. Хранить «историю стираний»
  // неудобно, потому что ластик должен стирать именно участки линий.
  //
  // Решение: используем offscreen-canvas, координаты которого — мировые.
  // Он создаётся достаточно большим, но мы будем «двигать» окно рендера.
  // Опять же — бесконечность.
  //
  // Практичный компромисс: сделаем offscreen большой, например 20000x20000,
  // со смещением центра в (10000, 10000) — это покрывает ±5000 px в каждую сторону
  // от старта. Для большинства задач этого хватит.
  //
  // Однако, чтобы остаться честными перед «бесконечностью», реализуем гибрид:
  // - карандаш пишет в массив штрихов (векторно)
  // - ластик стирает, удаляя/разрезая штрихи в массиве
  //
  // Это даёт настоящую бесконечность и корректное стирание.

  // Реализуем стирание через разрезание штрихов.

  // ========== РАЗМЕР ХОЛСТА ==========
  function resizeCanvas() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    mainCanvas.width = w;
    mainCanvas.height = h;
    mainCanvas.style.width = w + 'px';
    mainCanvas.style.height = h + 'px';
    render();
  }

  // ========== ПРЕОБРАЗОВАНИЯ КООРДИНАТ ==========
  // Экран → мир
  function screenToWorld(sx, sy) {
    return { x: sx + cameraX, y: sy + cameraY };
  }
  // Мир → экран
  function worldToScreen(wx, wy) {
    return { x: wx - cameraX, y: wy - cameraY };
  }

  // ========== КООРДИНАТЫ МЫШИ (в экранных) ==========
  function getMouseCoords(e) {
    const rect = mainCanvas.getBoundingClientRect();
    const scaleX = mainCanvas.width / rect.width;
    const scaleY = mainCanvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  // ========== ЛОКАЛЬНЫЕ КООРДИНАТЫ ЛИНЕЙКИ (в мировых) ==========
  function worldToRulerLocal(wx, wy) {
    const dx = wx - rulerCenterX;
    const dy = wy - rulerCenterY;
    const cos = Math.cos(-rulerAngle);
    const sin = Math.sin(-rulerAngle);
    return {
      x: dx * cos - dy * sin,
      y: dx * sin + dy * cos
    };
  }

  function rulerLocalToWorld(localX, localY) {
    const cos = Math.cos(rulerAngle);
    const sin = Math.sin(rulerAngle);
    return {
      x: rulerCenterX + localX * cos - localY * sin,
      y: rulerCenterY + localX * sin + localY * cos
    };
  }

  // ========== ПРОЕКЦИЯ НА РАБОЧУЮ КРОМКУ (мировые координаты) ==========
  function projectWorldToEdge(wx, wy) {
    const local = worldToRulerLocal(wx, wy);
    const clampedX = Math.max(-RULER_LENGTH / 2, Math.min(RULER_LENGTH / 2, local.x));
    return rulerLocalToWorld(clampedX, 0);
  }

  function isWithinRulerSpan(wx, wy) {
    const local = worldToRulerLocal(wx, wy);
    return local.x >= -RULER_LENGTH / 2 && local.x <= RULER_LENGTH / 2;
  }

  // ========== ОТРИСОВКА ==========
  function render() {
    const W = mainCanvas.width;
    const H = mainCanvas.height;

    // Фон
    mainCtx.fillStyle = '#fcfcfc';
    mainCtx.fillRect(0, 0, W, H);

    // Клетка — рисуем только видимую часть
    drawGridVisible(W, H);

    // Штрихи карандаша (мировые координаты → экранные)
    drawStrokes();

    // Линейка
    if (rulerVisible) {
      drawRulerOnMain();
    }
  }

  // ========== КЛЕТКА (только видимая часть) ==========
  function drawGridVisible(W, H) {
    // Определяем мировые границы видимой области
    const worldLeft = cameraX;
    const worldTop = cameraY;
    const worldRight = cameraX + W;
    const worldBottom = cameraY + H;

    // Начало сетки — округляем вниз до кратного GRID_SIZE
    const startX = Math.floor(worldLeft / GRID_SIZE) * GRID_SIZE;
    const startY = Math.floor(worldTop / GRID_SIZE) * GRID_SIZE;

    // Мелкая сетка
    mainCtx.strokeStyle = '#d0d8e8';
    mainCtx.lineWidth = 1;
    mainCtx.beginPath();
    for (let wx = startX; wx <= worldRight; wx += GRID_SIZE) {
      const sx = wx - cameraX + 0.5;
      mainCtx.moveTo(sx, 0);
      mainCtx.lineTo(sx, H);
    }
    for (let wy = startY; wy <= worldBottom; wy += GRID_SIZE) {
      const sy = wy - cameraY + 0.5;
      mainCtx.moveTo(0, sy);
      mainCtx.lineTo(W, sy);
    }
    mainCtx.stroke();

    // Крупная сетка
    const bigStep = GRID_SIZE * 5;
    const startBigX = Math.floor(worldLeft / bigStep) * bigStep;
    const startBigY = Math.floor(worldTop / bigStep) * bigStep;

    mainCtx.strokeStyle = '#b0bcd0';
    mainCtx.lineWidth = 1.2;
    mainCtx.beginPath();
    for (let wx = startBigX; wx <= worldRight; wx += bigStep) {
      const sx = wx - cameraX + 0.5;
      mainCtx.moveTo(sx, 0);
      mainCtx.lineTo(sx, H);
    }
    for (let wy = startBigY; wy <= worldBottom; wy += bigStep) {
      const sy = wy - cameraY + 0.5;
      mainCtx.moveTo(0, sy);
      mainCtx.lineTo(W, sy);
    }
    mainCtx.stroke();
  }

  // ========== ОТРИСОВКА ШТРИХОВ ==========
  function drawStrokes() {
    mainCtx.strokeStyle = '#1e2a3a';
    mainCtx.lineWidth = PENCIL_WIDTH;
    mainCtx.lineCap = 'round';
    mainCtx.lineJoin = 'round';

    const W = mainCanvas.width;
    const H = mainCanvas.height;

    // Границы видимой области в мировых координатах (с запасом)
    const padding = 50;
    const left = cameraX - padding;
    const top = cameraY - padding;
    const right = cameraX + W + padding;
    const bottom = cameraY + H + padding;

    mainCtx.beginPath();
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      // Отсечение: если весь отрезок вне видимой области — пропускаем
      if (s.x1 < left && s.x2 < left) continue;
      if (s.x1 > right && s.x2 > right) continue;
      if (s.y1 < top && s.y2 < top) continue;
      if (s.y1 > bottom && s.y2 > bottom) continue;

      const p1 = worldToScreen(s.x1, s.y1);
      const p2 = worldToScreen(s.x2, s.y2);
      mainCtx.moveTo(p1.x, p1.y);
      mainCtx.lineTo(p2.x, p2.y);
    }
    mainCtx.stroke();
  }

  // ========== ОТРИСОВКА ЛИНЕЙКИ ==========
  function drawRulerOnMain() {
    // Центр линейки в экранных координатах
    const screenCenter = worldToScreen(rulerCenterX, rulerCenterY);

    mainCtx.save();
    mainCtx.translate(screenCenter.x, screenCenter.y);
    mainCtx.rotate(rulerAngle);

    // Тело линейки
    mainCtx.fillStyle = 'rgba(180, 210, 255, 0.5)';
    mainCtx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    mainCtx.shadowBlur = 12;
    mainCtx.shadowOffsetY = 3;
    mainCtx.beginPath();
    mainCtx.rect(-RULER_LENGTH / 2, -RULER_THICKNESS, RULER_LENGTH, RULER_THICKNESS);
    mainCtx.fill();

    mainCtx.shadowColor = 'transparent';
    mainCtx.shadowBlur = 0;

    mainCtx.strokeStyle = 'rgba(60, 100, 200, 0.8)';
    mainCtx.lineWidth = 2;
    mainCtx.strokeRect(-RULER_LENGTH / 2, -RULER_THICKNESS, RULER_LENGTH, RULER_THICKNESS);

    // Рабочая кромка
    mainCtx.beginPath();
    mainCtx.moveTo(-RULER_LENGTH / 2, 0);
    mainCtx.lineTo(RULER_LENGTH / 2, 0);
    mainCtx.strokeStyle = '#3e6eff';
    mainCtx.lineWidth = 3;
    mainCtx.stroke();

    // Деления и цифры сверху
    const topEdgeY = -RULER_THICKNESS;
    mainCtx.textAlign = 'center';
    mainCtx.textBaseline = 'bottom';

    for (let x = -RULER_LENGTH / 2; x <= RULER_LENGTH / 2; x += TICK_STEP) {
      const value = Math.round(x / TICK_STEP);
      let tickLen, tickColor, tickWidth;
      if (value % 5 === 0) {
        tickLen = 22; tickColor = '#1a2b4a'; tickWidth = 2.2;
      } else {
        tickLen = 10; tickColor = '#5a6e9a'; tickWidth = 1;
      }

      mainCtx.beginPath();
      mainCtx.moveTo(x, topEdgeY);
      mainCtx.lineTo(x, topEdgeY + tickLen);
      mainCtx.strokeStyle = tickColor;
      mainCtx.lineWidth = tickWidth;
      mainCtx.stroke();

      if (value % 5 === 0) {
        mainCtx.fillStyle = '#1a2b4a';
        mainCtx.font = 'bold 14px "Segoe UI", sans-serif';
        mainCtx.fillText(value.toString(), x, topEdgeY - 4);
      }
    }

    // Угол
    const deg = Math.round(rulerAngle * 180 / Math.PI);
    mainCtx.font = 'bold 20px "Segoe UI", sans-serif';
    mainCtx.fillStyle = '#1f3d7a';
    mainCtx.textAlign = 'center';
    mainCtx.textBaseline = 'middle';
    mainCtx.fillText(`${deg}°`, 0, -RULER_THICKNESS / 2 + 8);

    // Ручка перетаскивания
    const handleY = -RULER_THICKNESS + 34;
    mainCtx.fillStyle = 'rgba(95, 138, 255, 0.9)';
    mainCtx.beginPath();
    mainCtx.arc(0, handleY, 8, 0, Math.PI * 2);
    mainCtx.fill();
    mainCtx.strokeStyle = '#2a4b9a';
    mainCtx.lineWidth = 1.5;
    mainCtx.stroke();

    mainCtx.fillStyle = '#ffffff';
    mainCtx.beginPath();
    mainCtx.arc(0, handleY, 3, 0, Math.PI * 2);
    mainCtx.fill();

    mainCtx.restore();
  }

  // ========== ДОБАВЛЕНИЕ ШТРИХА ==========
  function addStroke(x1, y1, x2, y2) {
    strokes.push({ x1, y1, x2, y2 });
  }

  // ========== СТИРАНИЕ ШТРИХОВ ==========
  // Стираем участки линий, попадающие в круг (wx, wy, radius).
  // Разрезаем линии на части, удаляя стёртые участки.
  function eraseStrokesAt(wx, wy, radius) {
    const r2 = radius * radius;
    const newStrokes = [];

    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      // Разбиваем отрезок на мелкие сегменты и проверяем каждый
      // Для точности разбиваем на N шагов
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy);
      if (len < 0.001) continue;

      const steps = Math.max(2, Math.ceil(len / 4)); // сегмент ~4 px
      let currentStart = null;

      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const px = s.x1 + dx * t;
        const py = s.y1 + dy * t;
        const dist2 = (px - wx) * (px - wx) + (py - wy) * (py - wy);
        const inside = dist2 <= r2;

        if (!inside) {
          if (currentStart === null) {
            currentStart = { x: px, y: py };
          }
        } else {
          if (currentStart !== null) {
            // Заканчиваем текущий незакрытый сегмент
            const lastT = (k - 1) / steps;
            const endX = s.x1 + dx * lastT;
            const endY = s.y1 + dy * lastT;
            newStrokes.push({
              x1: currentStart.x,
              y1: currentStart.y,
              x2: endX,
              y2: endY
            });
            currentStart = null;
          }
        }
      }
      // Если дошли до конца с открытым сегментом — закрываем в конце
      if (currentStart !== null) {
        newStrokes.push({
          x1: currentStart.x,
          y1: currentStart.y,
          x2: s.x2,
          y2: s.y2
        });
      }
    }

    strokes.length = 0;
    for (let i = 0; i < newStrokes.length; i++) {
      strokes.push(newStrokes[i]);
    }
  }

  // ========== ОБРАБОТЧИКИ ==========
  function onMouseDown(e) {
    e.preventDefault();
    if (e.button !== 0) return; // только левая кнопка

    const screen = getMouseCoords(e);
    const world = screenToWorld(screen.x, screen.y);

    // Приоритет 1: перетаскивание линейки
    if (rulerVisible && currentTool !== 'hand') {
      const local = worldToRulerLocal(world.x, world.y);
      const handleLocalY = -RULER_THICKNESS + 34;
      const dxH = local.x;
      const dyH = local.y - handleLocalY;
      const onHandle = (dxH * dxH + dyH * dyH) <= 14 * 14;

      const insideBody = local.x >= -RULER_LENGTH / 2 &&
                         local.x <= RULER_LENGTH / 2 &&
                         local.y >= -RULER_THICKNESS &&
                         local.y <= 0;

      if (onHandle || insideBody) {
        isDraggingRuler = true;
        dragOffsetX = rulerCenterX - world.x;
        dragOffsetY = rulerCenterY - world.y;
        mainCanvas.style.cursor = 'grabbing';
        return;
      }
    }

    // Приоритет 2: рука — панорамирование
    if (currentTool === 'hand') {
      isPanning = true;
      panStartX = screen.x;
      panStartY = screen.y;
      panCameraStartX = cameraX;
      panCameraStartY = cameraY;
      mainCanvas.style.cursor = 'grabbing';
      return;
    }

    // Приоритет 3: карандаш
    if (currentTool === 'pencil') {
      if (rulerVisible) {
        if (!isWithinRulerSpan(world.x, world.y)) return;
        isDrawing = true;
        const proj = projectWorldToEdge(world.x, world.y);
        lastPencilX = proj.x;
        lastPencilY = proj.y;
        // Рисуем точку — отрезок нулевой длины, отобразится как круглая точка
        addStroke(proj.x, proj.y, proj.x + 0.01, proj.y);
        render();
      } else {
        isDrawing = true;
        lastPencilX = world.x;
        lastPencilY = world.y;
        addStroke(world.x, world.y, world.x + 0.01, world.y);
        render();
      }
    } 
    // Приоритет 4: ластик
    else if (currentTool === 'eraser') {
      isErasing = true;
      eraseStrokesAt(world.x, world.y, ERASER_RADIUS);
      render();
    }
  }

  function onMouseMove(e) {
    const screen = getMouseCoords(e);
    const world = screenToWorld(screen.x, screen.y);

    // Перетаскивание линейки
    if (isDraggingRuler) {
      rulerCenterX = world.x + dragOffsetX;
      rulerCenterY = world.y + dragOffsetY;
      render();
      return;
    }

    // Панорамирование
    if (isPanning) {
      const dx = screen.x - panStartX;
      const dy = screen.y - panStartY;
      cameraX = panCameraStartX - dx;
      cameraY = panCameraStartY - dy;
      render();
      return;
    }

    // Смена курсора
    if (rulerVisible && !isDrawing && !isErasing && !isPanning && currentTool !== 'hand') {
      const local = worldToRulerLocal(world.x, world.y);
      const handleLocalY = -RULER_THICKNESS + 34;
      const dxH = local.x;
      const dyH = local.y - handleLocalY;
      const onHandle = (dxH * dxH + dyH * dyH) <= 14 * 14;
      const insideBody = local.x >= -RULER_LENGTH / 2 &&
                         local.x <= RULER_LENGTH / 2 &&
                         local.y >= -RULER_THICKNESS &&
                         local.y <= 0;

      if (onHandle) mainCanvas.style.cursor = 'grab';
      else if (insideBody) mainCanvas.style.cursor = 'move';
      else mainCanvas.style.cursor = currentTool === 'eraser' ? 'cell' : 'crosshair';
    } else if (currentTool === 'hand' && !isPanning) {
      mainCanvas.style.cursor = 'grab';
    }

    // Рисование
    if (isDrawing && currentTool === 'pencil') {
      if (rulerVisible) {
        if (!isWithinRulerSpan(world.x, world.y)) {
          isDrawing = false;
          lastPencilX = null;
          lastPencilY = null;
          return;
        }
        const proj = projectWorldToEdge(world.x, world.y);
        if (lastPencilX !== null && lastPencilY !== null) {
          addStroke(lastPencilX, lastPencilY, proj.x, proj.y);
        }
        lastPencilX = proj.x;
        lastPencilY = proj.y;
        render();
      } else {
        if (lastPencilX !== null && lastPencilY !== null) {
          addStroke(lastPencilX, lastPencilY, world.x, world.y);
        }
        lastPencilX = world.x;
        lastPencilY = world.y;
        render();
      }
    } 
    else if (isErasing && currentTool === 'eraser') {
      eraseStrokesAt(world.x, world.y, ERASER_RADIUS);
      render();
    }
  }

  function onMouseUp() {
    if (isDrawing) {
      isDrawing = false;
      lastPencilX = null;
      lastPencilY = null;
    }
    if (isErasing) isErasing = false;
    if (isDraggingRuler) {
      isDraggingRuler = false;
      mainCanvas.style.cursor = currentTool === 'eraser' ? 'cell' : 'crosshair';
    }
    if (isPanning) {
      isPanning = false;
      mainCanvas.style.cursor = currentTool === 'hand' ? 'grab' : 'crosshair';
    }
  }

  function onMouseLeave() {
    onMouseUp();
  }

  // ========== КОЛЕСИКО ==========
  function onWheel(e) {
    e.preventDefault();

    if (!rulerVisible) {
      // Если линейки нет — можно сделать зум (необязательно). Пока ничего.
      return;
    }

    const delta = e.deltaY > 0 ? 1 : -1;
    const step = 2 * Math.PI / 180;
    rulerAngle += delta * step;

    const deg = Math.round(rulerAngle * 180 / Math.PI);
    document.getElementById('angleDisplay').textContent = `${deg}°`;

    render();
  }

  // ========== ПЕРЕКЛЮЧЕНИЕ ИНСТРУМЕНТОВ ==========
  const pencilBtn = document.getElementById('pencilTool');
  const eraserBtn = document.getElementById('eraserTool');
  const rulerToggleBtn = document.getElementById('rulerToggle');
  const handBtn = document.getElementById('handTool');

  function setActiveTool(tool) {
    currentTool = tool;
    pencilBtn.classList.toggle('active', tool === 'pencil');
    eraserBtn.classList.toggle('active', tool === 'eraser');
    handBtn.classList.toggle('active', tool === 'hand');

    if (tool === 'hand') {
      mainCanvas.style.cursor = 'grab';
    } else if (tool === 'eraser') {
      mainCanvas.style.cursor = 'cell';
    } else {
      mainCanvas.style.cursor = 'crosshair';
    }
  }

  pencilBtn.addEventListener('click', () => setActiveTool('pencil'));
  eraserBtn.addEventListener('click', () => setActiveTool('eraser'));
  handBtn.addEventListener('click', () => setActiveTool('hand'));

  rulerToggleBtn.addEventListener('click', () => {
    rulerVisible = !rulerVisible;
    rulerToggleBtn.classList.toggle('active', rulerVisible);

    if (!rulerVisible) {
      isDrawing = false;
      lastPencilX = null;
      lastPencilY = null;
      isDraggingRuler = false;
    }
    render();
  });

  // ========== ЗАПУСК ==========
  function init() {
    // Стартовая позиция линейки в мировых координатах
    rulerCenterX = 0;
    rulerCenterY = 0;

    // Камера: показываем область вокруг (0, 0)
    cameraX = -window.innerWidth / 2;
    cameraY = -window.innerHeight / 2;

    resizeCanvas();

    window.addEventListener('resize', resizeCanvas);

    mainCanvas.addEventListener('mousedown', onMouseDown);
    mainCanvas.addEventListener('mousemove', onMouseMove);
    mainCanvas.addEventListener('mouseup', onMouseUp);
    mainCanvas.addEventListener('mouseleave', onMouseLeave);
    mainCanvas.addEventListener('wheel', onWheel, { passive: false });
    mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.getElementById('angleDisplay').textContent = '0°';
  }

  init();
})();