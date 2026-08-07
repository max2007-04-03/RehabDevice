export class UIManager {
    constructor(stateManager, networkService) {
        this.stateManager = stateManager;
        this.networkService = networkService;
        this.doctorChart = null;
        this.selectedDoctorPatient = "ALL";
    }

    init() {
        this.initChart();
        this.setupTabNavigation();
        this.setupEventListeners();
        
        // Subscribe to state changes
        this.stateManager.subscribe('isConnected', (isConn) => {
            this.updateConnectionStatus(isConn, this.stateManager.get('isHttpFallback'));
        });
        
        this.stateManager.subscribe('isHttpFallback', (isFall) => {
            this.updateConnectionStatus(this.stateManager.get('isConnected'), isFall);
        });

        this.stateManager.subscribe('isAuthorized', (isAuth) => this.toggleAuthUI(isAuth));
        
        this.stateManager.subscribe('currentFirmwareVersion', (version) => {
            const verElem = document.getElementById("currentFwVersion");
            if (verElem) verElem.textContent = version;
        });

        this.stateManager.subscribe('liveStats', (stats) => {
            if (stats) this.updateLiveStats(stats);
        });

        this.stateManager.subscribe('memoryUsage', (mem) => this.updateMemory(mem));
        
        this.stateManager.subscribe('targetAngle', (angle) => {
            const valElem = document.getElementById("angleValueElem");
            if (valElem) valElem.textContent = angle.toFixed(1);
        });
        
        this.stateManager.subscribe('currentPatientName', (name) => {
            const el = document.getElementById("activePatientName");
            if (el) el.textContent = name;
        });
    }

    updateConnectionStatus(isConnected, isHttpFallback) {
        const dot = document.getElementById("statusDot");
        const text = document.getElementById("statusText");
        
        if (!dot || !text) return;
        
        if (isConnected) {
            dot.classList.add("connected");
            text.textContent = isHttpFallback ? "Пристрій підключено (HTTP)" : "Пристрій підключено";
            text.style.color = "";
        } else {
            dot.classList.remove("connected");
            text.textContent = isHttpFallback ? "Відключено (очікування HTTP...)" : "Відключено (перепідключення...)";
        }
    }

    updateMemory(mem) {
        const memoryText = document.getElementById("memoryText");
        const memoryLabel = document.getElementById("memoryTypeLabel");
        const isSdAvailable = this.stateManager.get('globalSdAvailable');
        
        if (memoryLabel) {
            memoryLabel.textContent = isSdAvailable ? "Пам'ять (SD-карта)" : "Пам'ять (LittleFS)";
        }
        if (memoryText) {
            document.getElementById("memoryBar").style.width = isSdAvailable ? '100%' : '50%';
            memoryText.textContent = "База даних активна";
            memoryText.style.color = "";
        }
    }

    toggleAuthUI(isAuthorized) {
        const guestPanel = document.getElementById("authGuestPanel");
        const activePanel = document.getElementById("authActivePanel");
        const liveStats = document.getElementById("liveStatsPanel");
        const patientInput = document.getElementById("patientIdInput");

        if (isAuthorized) {
            if (guestPanel) guestPanel.style.display = "none";
            if (activePanel) activePanel.style.display = "flex";
            if (liveStats) liveStats.style.display = "block";
        } else {
            if (guestPanel) guestPanel.style.display = "flex";
            if (activePanel) activePanel.style.display = "none";
            if (liveStats) liveStats.style.display = "none";
            if (patientInput) patientInput.value = "";
        }
    }

    updateLiveStats(data) {
        document.getElementById("statMin").textContent = `${data.minAngle.toFixed(1)}°`;
        document.getElementById("statMax").textContent = `${data.maxAngle.toFixed(1)}°`;
        document.getElementById("statAmp").textContent = `${data.amplitude.toFixed(1)}°`;
        document.getElementById("statSpeed").textContent = `${data.avgSpeed.toFixed(1)}°/с`;
        document.getElementById("statSmooth").textContent = `${data.smoothness.toFixed(0)}%`;
        document.getElementById("statFlex").textContent = `${data.flexionsCount}`;
        document.getElementById("statDuration").textContent = `${data.sessionDuration.toFixed(1)} с`;
    }

    setupTabNavigation() {
        const tabBtns = document.querySelectorAll(".tab-btn");
        const tabContents = document.querySelectorAll(".tab-content");

        tabBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                tabBtns.forEach(b => b.classList.remove("active"));
                tabContents.forEach(c => c.classList.remove("active"));

                btn.classList.add("active");
                const targetId = btn.getAttribute("data-tab");
                document.getElementById(targetId).classList.add("active");

                if (targetId === "tabDoctor") {
                    this.updateDoctorDashboardView();
                    this.networkService.fetchAllSessionsPaginated();
                }
            });
        });

        window.addEventListener("resize", () => {
            if (document.getElementById("tabDoctor") && document.getElementById("tabDoctor").classList.contains("active")) {
                this.updateDoctorDashboardView();
            }
        });
    }

    setupEventListeners() {
        const btnStart = document.getElementById("btnStartSession");
        if (btnStart) {
            btnStart.addEventListener("click", () => {
                const input = document.getElementById("patientIdInput");
                const name = input.value.trim();
                if (!name) {
                    alert("Будь ласка, введіть ПІБ пацієнта для початку сесії.");
                    return;
                }
                
                if (!this.stateManager.get('globalSdAvailable')) {
                    alert("⚠️ УВАГА: SD-карта відсутня. Ви можете проводити тренування та грати, але історія цієї сесії не буде збережена у довгостроковий архів.");
                }
                
                this.networkService.sendCommand("startSession", { patientId: name });
                
                // Set state directly
                this.stateManager.updateMultiple({
                    isAuthorized: true,
                    currentPatientName: name
                });

                // Extract baseline calibration from history for this patient
                let calibMin = -20;
                let calibMax = 20;
                const allSessionsData = this.stateManager.get('allSessionsData');
                if (allSessionsData) {
                    const patientSessions = allSessionsData.filter(s => s.patientId === name);
                    if (patientSessions.length > 0) {
                        patientSessions.sort((a,b) => (b.timestamp || 0) - (a.timestamp || 0));
                        const last = patientSessions[0];
                        if (last.minAngle !== undefined && last.maxAngle !== undefined) {
                            let min = parseFloat(last.minAngle) || 0;
                            let max = parseFloat(last.maxAngle) || 0;
                            if (max - min < 10) { min -= 5; max += 5; }
                            calibMin = min;
                            calibMax = max;
                        }
                    }
                }
                this.stateManager.updateMultiple({ calibMin, calibMax });
            });
        }

        const btnStop = document.getElementById("btnStopSession");
        if (btnStop) {
            btnStop.addEventListener("click", () => {
                const engine = window.engineInstance;
                if (engine) engine.stopGame();
                this.networkService.sendCommand("stopSession");
                this.stateManager.update('isAuthorized', false);
                setTimeout(() => this.networkService.fetchAllSessionsPaginated(), 500);
            });
        }

        const btnRecalibrate = document.getElementById("btnRecalibrate");
        if (btnRecalibrate) {
            btnRecalibrate.addEventListener("click", () => {
                this.networkService.sendCommand("recalibrate");
                const originalText = btnRecalibrate.textContent;
                btnRecalibrate.textContent = "Калібрується...";
                setTimeout(() => { btnRecalibrate.textContent = originalText; }, 1200);
            });
        }

        const searchInput = document.getElementById("patientSearchInput");
        const exactSearchBtn = document.getElementById("btnExactSearch");
        
        const performExactSearch = () => {
            if (!searchInput) return;
            const query = searchInput.value.trim();
            if (query.length === 0) {
                this.selectPatientByPill("ALL", true);
            } else {
                this.updateDoctorDashboardView(query, true);
            }
        };

        if (exactSearchBtn) exactSearchBtn.addEventListener("click", performExactSearch);
        if (searchInput) {
            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") performExactSearch();
            });
        }

        const btnDeletePatient = document.getElementById("btnDeletePatient");
        if (btnDeletePatient) {
            btnDeletePatient.addEventListener("click", () => {
                if (this.selectedDoctorPatient === "ALL") return;
                const result = confirm(`Ви дійсно хочете безповоротно видалити ВСІ записи пацієнта «${this.selectedDoctorPatient}» з флеш-пам'яті пристрою?`);
                if (result) {
                    this.networkService.sendCommand("deletePatient", { patientId: this.selectedDoctorPatient });
                    this.selectPatientByPill("ALL", true);
                    setTimeout(() => this.networkService.fetchAllSessionsPaginated(), 1000); // refresh
                }
            });
        }

        const btnDownloadCSV = document.getElementById("btnDownloadCSV");
        if (btnDownloadCSV) {
            btnDownloadCSV.addEventListener("click", () => {
                this.downloadCSV(this.stateManager.get('allSessionsData') || [], "All_Patients_Sessions.csv");
            });
        }

        const btnDownloadClientCSV = document.getElementById("btnDownloadClientCSV");
        if (btnDownloadClientCSV) {
            btnDownloadClientCSV.addEventListener("click", () => {
                if (this.selectedDoctorPatient === "ALL") {
                    alert("Будь ласка, оберіть конкретного пацієнта.");
                    return;
                }
                const all = this.stateManager.get('allSessionsData') || [];
                const filtered = all.filter(s => (s.patientId || "").trim() === this.selectedDoctorPatient);
                this.downloadCSV(filtered, `${this.selectedDoctorPatient}_Sessions.csv`);
            });
        }

        const normInput = document.getElementById("targetNormInput");
        if (normInput) {
            normInput.addEventListener("input", () => this.updateDoctorDashboardView());
        }

        const btnModeGame = document.getElementById("btnModeGame");
        const btnExitGame = document.getElementById("btnExitGame");
        const gameContainer = document.getElementById("gameContainer");

        if (btnModeGame) {
            btnModeGame.addEventListener("click", () => {
                this.stateManager.update('currentAppMode', 'game');
                if (gameContainer) gameContainer.style.display = "flex";
                const gameSelect = document.getElementById("gameSelect");
                const engine = window.engineInstance;
                if (gameSelect && engine) {
                    engine.startGame(gameSelect.value);
                }
            });
        }
        
        if (btnExitGame) {
            btnExitGame.addEventListener("click", () => {
                const engine = window.engineInstance;
                if (engine) engine.stopGame();
            });
        }
    }

    renderPatientPills(sessions) {
        const container = document.getElementById("patientPillsContainer");
        if (!container) return;

        const counts = {};
        sessions.forEach(s => {
            const name = (s.patientId || "Пацієнт").trim();
            counts[name] = (counts[name] || 0) + 1;
        });

        const uniquePatients = Object.keys(counts).sort((a, b) => a.localeCompare(b, "uk"));

        container.innerHTML = "";
        const fragment = document.createDocumentFragment();

        const allBtn = document.createElement("button");
        allBtn.className = `patient-pill ${this.selectedDoctorPatient === "ALL" ? "active" : ""}`;
        allBtn.setAttribute("data-patient", "ALL");
        allBtn.textContent = `🧑 Всі пацієнти (${sessions.length})`;
        allBtn.onclick = () => this.selectPatientByPill("ALL", true);
        fragment.appendChild(allBtn);

        uniquePatients.forEach(name => {
            const btn = document.createElement("button");
            btn.className = `patient-pill ${this.selectedDoctorPatient === name ? "active" : ""}`;
            btn.setAttribute("data-patient", name);
            btn.textContent = `👤 ${name} (${counts[name]})`;
            btn.onclick = () => this.selectPatientByPill(name, true);
            fragment.appendChild(btn);
        });

        container.appendChild(fragment);
    }

    selectPatientByPill(patientName, triggerUpdate = true) {
        this.selectedDoctorPatient = patientName;
        
        document.querySelectorAll(".patient-pill").forEach(btn => {
            if (btn.getAttribute("data-patient") === patientName) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        });

        const searchInput = document.getElementById("patientSearchInput");
        if (searchInput && triggerUpdate) searchInput.value = "";

        if (triggerUpdate) this.updateDoctorDashboardView();
    }

    updateDoctorDashboardView(searchQuery = "", isExactSearch = false) {
        const filterLabel = document.getElementById("tableFilterLabel");
        const summaryBox = document.getElementById("patientSummaryContainer");
        const allSessionsData = this.stateManager.get('allSessionsData') || [];

        const chartWrapper = document.getElementById("chartWrapperContainer");

        if (allSessionsData.length === 0) {
            if (summaryBox) {
                summaryBox.innerHTML = `
                    <div style="padding: 2.5rem 1rem; text-align: center; background: rgba(0, 242, 254, 0.05); border: 1px dashed rgba(0, 242, 254, 0.3); border-radius: 14px; margin-bottom: 0.5rem;">
                        <div style="font-size: 3rem; margin-bottom: 1rem;">🏥</div>
                        <h3 style="color: #00f2fe; font-size: 1.3rem; margin-bottom: 0.5rem; font-weight: 700;">База даних порожня</h3>
                        <p style="color: var(--text-secondary); font-size: 0.95rem; max-width: 500px; margin: 0 auto; line-height: 1.5;">В базі даних ще немає жодного запису. Проведіть перше тренування з пацієнтом, щоб тут з'явилась аналітика.</p>
                    </div>`;
                summaryBox.style.display = "block";
            }
            if (chartWrapper) chartWrapper.style.display = "none";
            if (filterLabel) filterLabel.textContent = "(Всі пацієнти)";
            
            const btnDownloadCSV = document.getElementById("btnDownloadCSV");
            if (btnDownloadCSV) btnDownloadCSV.style.display = "none";
            
            return;
        } else {
            const btnDownloadCSV = document.getElementById("btnDownloadCSV");
            if (btnDownloadCSV) btnDownloadCSV.style.display = "inline-block";
            if (chartWrapper) chartWrapper.style.display = "block";
        }

        let filtered = allSessionsData;
        if (isExactSearch && searchQuery && typeof searchQuery === "string" && searchQuery.length > 0) {
            const query = searchQuery.trim().toLowerCase();
            filtered = allSessionsData.filter(s => (s.patientId || "").trim().toLowerCase() === query);
            if (filtered.length === 0) {
                filtered = allSessionsData.filter(s => (s.patientId || "").trim().toLowerCase().includes(query));
            }

            if (filterLabel) filterLabel.textContent = `(Пошук: «${searchQuery.trim()}» — знайдено: ${filtered.length})`;
            if (filtered.length > 0) {
                this.selectedDoctorPatient = (filtered[0].patientId || "Пацієнт").trim();
                document.querySelectorAll(".patient-pill").forEach(btn => {
                    btn.classList.toggle("active", btn.getAttribute("data-patient") === this.selectedDoctorPatient);
                });
            }
        } else if (this.selectedDoctorPatient && this.selectedDoctorPatient !== "ALL") {
            filtered = allSessionsData.filter(s => (s.patientId || "Пацієнт").trim() === this.selectedDoctorPatient);
            if (filterLabel) filterLabel.textContent = `(Пацієнт: ${this.selectedDoctorPatient})`;
        } else {
            if (filterLabel) filterLabel.textContent = "(Всі пацієнти)";
        }

        const normInput = document.getElementById("targetNormInput");
        const targetNorm = normInput ? (parseFloat(normInput.value) || 90.0) : 90.0;

        if (isExactSearch && searchQuery && filtered.length === 0 && summaryBox) {
            summaryBox.innerHTML = "";
            const notFoundMsg = document.createElement("div");
            notFoundMsg.style.cssText = "padding: 1.8rem 1rem; text-align: center; background: rgba(255, 23, 68, 0.08); border: 1px dashed rgba(255, 23, 68, 0.45); border-radius: 14px; margin-bottom: 0.5rem;";
            
            const icon = document.createElement("div");
            icon.style.cssText = "font-size: 2.5rem; margin-bottom: 0.6rem;";
            icon.textContent = "🔍 📭";
            
            const title = document.createElement("h3");
            title.style.cssText = "color: #ff1744; font-size: 1.2rem; margin-bottom: 0.4rem; font-weight: 700;";
            title.textContent = `За запитом «${searchQuery.trim()}» нічого не знайдено`;
            
            const p = document.createElement("p");
            p.style.cssText = "color: var(--text-secondary); font-size: 0.88rem; margin-bottom: 1.2rem; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.45;";
            p.textContent = "Пацієнтів або збережених сесій з таким іменем в історії немає.";
            
            const btn = document.createElement("button");
            btn.className = "btn btn-secondary";
            btn.style.cssText = "padding: 0.5rem 1.2rem; font-size: 0.88rem; border-radius: 8px;";
            btn.textContent = "🧑 Показати всіх пацієнтів";
            btn.onclick = () => this.selectPatientByPill("ALL", true);
            
            notFoundMsg.appendChild(icon);
            notFoundMsg.appendChild(title);
            notFoundMsg.appendChild(p);
            notFoundMsg.appendChild(btn);
            
            summaryBox.appendChild(notFoundMsg);
            summaryBox.style.display = "block";
        } else if ((this.selectedDoctorPatient !== "ALL" || searchQuery) && filtered.length > 0 && summaryBox) {
            
            if (!document.getElementById("summaryPatientName")) {
                summaryBox.innerHTML = `
                    <div class="summary-header">
                        <h4 style="margin:0; color:var(--accent-primary); font-size:1.05rem;" id="summaryPatientNameLabel">
                            👤 Клінічна динаміка: <span id="summaryPatientName" style="color:#ffffff; font-weight:700;">—</span>
                        </h4>
                        <span id="summaryProgressBadge" class="progress-badge">🔥 Прогрес: 0°</span>
                    </div>
                    <div class="summary-grid">
                        <div class="summary-card">
                            <div class="label">1-ша сесія (<span id="summaryStartDate">—</span>)</div>
                            <div class="val" id="summaryStartAmp">0°</div>
                        </div>
                        <div class="summary-card">
                            <div class="label">Поточна (<span id="summaryCurrentDate">—</span>)</div>
                            <div class="val" id="summaryCurrentAmp" style="color:#00f2fe;">0°</div>
                        </div>
                        <div class="summary-card">
                            <div class="label">Середня плавність</div>
                            <div class="val" id="summaryAvgSmooth" style="color:#00e676;">0%</div>
                        </div>
                        <div class="summary-card">
                            <div class="label">Індекс відновлення</div>
                            <div class="val" id="recoveryIndexVal" style="color:#00e676;">0%</div>
                        </div>
                    </div>
                    <div style="margin-top: 0.8rem; font-size: 0.82rem; color: var(--text-secondary); display: flex; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.6rem;">
                        <span>Всього проведено сесій: <strong id="summaryTotalSessions" style="color:#fff;">0</strong></span>
                        <span>Загальна кількість згинань: <strong id="summaryTotalFlexions" style="color:#fff;">0</strong></span>
                    </div>
                `;
            }

            const chrono = filtered.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            const first = chrono[0];
            const latest = chrono[chrono.length - 1];

            const patientTitle = this.selectedDoctorPatient !== "ALL" ? this.selectedDoctorPatient : (latest.patientId || "Пацієнт");
            document.getElementById("summaryPatientName").textContent = patientTitle;
            document.getElementById("summaryStartAmp").textContent = `${(first.amplitude || 0).toFixed(1)}°`;
            document.getElementById("summaryStartDate").textContent = first.dateStr || "1-ша сесія";

            document.getElementById("summaryCurrentAmp").textContent = `${(latest.amplitude || 0).toFixed(1)}°`;
            document.getElementById("summaryCurrentDate").textContent = latest.dateStr || "Поточна";

            const diffAmp = (latest.amplitude || 0) - (first.amplitude || 0);
            const percent = (first.amplitude && first.amplitude > 0) ? Math.round((diffAmp / first.amplitude) * 100) : 0;
            
            const badge = document.getElementById("summaryProgressBadge");
            if (diffAmp >= 0) {
                badge.className = "progress-badge";
                badge.textContent = `🔥 Прогрес: +${diffAmp.toFixed(1)}° (+${percent}%)`;
            } else {
                badge.className = "progress-badge negative";
                badge.textContent = `⚠️ Динаміка: ${diffAmp.toFixed(1)}° (${percent}%)`;
            }

            const avgSmooth = Math.round(filtered.reduce((sum, s) => sum + (s.smoothness || 0), 0) / filtered.length);
            document.getElementById("summaryAvgSmooth").textContent = `${avgSmooth}%`;
            document.getElementById("summaryTotalSessions").textContent = `${filtered.length}`;
            const totalFlex = filtered.reduce((sum, s) => sum + (s.flexionsCount || 0), 0);
            document.getElementById("summaryTotalFlexions").textContent = `${totalFlex}`;

            const recoveryIndex = Math.min(100, Math.round(((latest.amplitude || 0) / targetNorm) * 100));
            const recElem = document.getElementById("recoveryIndexVal");
            if (recElem) {
                recElem.textContent = `${recoveryIndex}%`;
                recElem.style.color = recoveryIndex >= 85 ? "#00e676" : (recoveryIndex >= 60 ? "#ff9100" : "#ff1744");
            }

            summaryBox.style.display = "block";
        } else if (summaryBox) {
            summaryBox.style.display = "none";
        }

        this.renderDoctorSessions(filtered);
    }

    renderDoctorSessions(sessions) {
        const tbody = document.getElementById("sessionsTableBody");
        const chartWrap = document.querySelector(".chart-wrapper");
        if (!tbody) return;
        tbody.innerHTML = "";

        if (sessions.length === 0) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 8;
            td.style.cssText = "text-align:center; padding: 2.5rem 1rem; color: var(--text-secondary); background: rgba(0,0,0,0.15); border-radius: 8px; white-space: normal; word-break: break-word;";
            td.textContent = "📭 Збережені сесії поки що відсутні для даного вибору. Проведіть тренування у вкладці пацієнта або змініть параметри пошуку.";
            tr.appendChild(td);
            tbody.appendChild(tr);
            
            if (chartWrap) chartWrap.style.display = "none";
            return;
        }

        if (chartWrap) chartWrap.style.display = "block";

        const fragment = document.createDocumentFragment();

        sessions.slice().reverse().forEach(rec => {
            const tr = document.createElement("tr");
            
            const tdName = document.createElement("td");
            tdName.style.cssText = "font-weight:700; color:var(--accent-primary); cursor:pointer; text-decoration: underline; text-underline-offset: 3px;";
            tdName.textContent = rec.patientId || "Пацієнт";
            tdName.onclick = () => this.selectPatientByPill(tdName.textContent, true);
            
            const tdDate = document.createElement("td");
            tdDate.style.whiteSpace = "nowrap";
            tdDate.textContent = rec.dateStr || "—";
            
            const tdMinMax = document.createElement("td");
            tdMinMax.style.whiteSpace = "nowrap";
            tdMinMax.innerHTML = `<span style="color:#cbd5e1; font-weight:600;">${(rec.minAngle||0).toFixed(1)}°</span> <span style="color:#64748b;">..</span> <span style="color:#00e676; font-weight:600;">${(rec.maxAngle||0).toFixed(1)}°</span>`;
            
            const tdAmp = document.createElement("td");
            tdAmp.style.cssText = "color:#00f2fe; font-weight:700;";
            tdAmp.textContent = `${(rec.amplitude||0).toFixed(1)}°`;
            
            const tdSpeed = document.createElement("td");
            tdSpeed.textContent = `${(rec.avgSpeed||0).toFixed(1)}°/с`;
            
            const tdSmooth = document.createElement("td");
            tdSmooth.style.cssText = "color:#00e676; font-weight:700;";
            tdSmooth.textContent = `${(rec.smoothness||0).toFixed(0)}%`;
            
            const tdFlex = document.createElement("td");
            tdFlex.textContent = rec.flexionsCount || 0;
            
            const tdActions = document.createElement("td");
            tdActions.style.textAlign = "center";
            const btnDel = document.createElement("button");
            btnDel.className = "btn";
            btnDel.style.cssText = "padding: 0.25rem 0.6rem; font-size: 0.75rem; background: rgba(255,23,68,0.18); border-color: rgba(255,23,68,0.4); color: #ff1744;";
            btnDel.textContent = "🗑️";
            btnDel.onclick = () => {
                if(confirm("Видалити запис?")) {
                    this.networkService.sendCommand("deleteSession", { id: rec.id });
                    setTimeout(() => this.networkService.fetchAllSessionsPaginated(), 800);
                }
            };
            tdActions.appendChild(btnDel);

            tr.append(tdName, tdDate, tdMinMax, tdAmp, tdSpeed, tdSmooth, tdFlex, tdActions);
            fragment.appendChild(tr);
        });

        tbody.appendChild(fragment);
        this.updateChartData(sessions);
    }

    initChart() {
        const ctx = document.getElementById("doctorChartCanvas");
        if (!ctx || typeof Chart === "undefined") return;

        const backgroundZonesPlugin = {
            id: 'backgroundZones',
            beforeDraw: (chart) => {
                const { ctx, chartArea, scales: { x, y } } = chart;
                if (!chartArea) return;
                
                ctx.save();
                
                // Тревожная зона: X=0..40, Y=0..50
                const xRedStart = x.getPixelForValue(0);
                const xRedEnd = x.getPixelForValue(40);
                const yRedStart = y.getPixelForValue(50);
                const yRedEnd = y.getPixelForValue(0);
                
                ctx.fillStyle = 'rgba(255, 23, 68, 0.05)';
                ctx.fillRect(xRedStart, yRedStart, xRedEnd - xRedStart, yRedEnd - yRedStart);
                
                // Целевая зона: X=60..100, Y=80..180
                const xGreenStart = x.getPixelForValue(60);
                const xGreenEnd = x.getPixelForValue(100);
                const yGreenStart = y.getPixelForValue(180);
                const yGreenEnd = y.getPixelForValue(80);
                
                ctx.fillStyle = 'rgba(0, 230, 118, 0.05)';
                ctx.fillRect(xGreenStart, yGreenStart, xGreenEnd - xGreenStart, yGreenEnd - yGreenStart);
                
                ctx.restore();
            }
        };

        this.doctorChart = new Chart(ctx, {
            type: "bubble",
            data: {
                datasets: [{
                    label: "Сесії (Матриця відновлення)",
                    data: [],
                    backgroundColor: [],
                    borderColor: [],
                    borderWidth: 1.5
                }]
            },
            plugins: [backgroundZonesPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                const data = context.raw;
                                return [
                                    `Амплітуда: ${(data.y || 0).toFixed(1)}°`,
                                    `Плавність: ${(data.x || 0).toFixed(1)}%`,
                                    `Згинання: ${data.flexions} шт.`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        min: 0,
                        max: 100,
                        title: { display: true, text: 'Плавність / Smoothness (%)', color: '#94a3b8' },
                        grid: { color: "rgba(255, 255, 255, 0.06)" },
                        ticks: { color: "#94a3b8" }
                    },
                    y: {
                        type: 'linear',
                        min: 0,
                        max: 180,
                        title: { display: true, text: 'Амплітуда / Amplitude (°)', color: '#94a3b8' },
                        grid: { color: "rgba(255, 255, 255, 0.06)" },
                        ticks: { color: "#94a3b8" }
                    }
                }
            }
        });
    }

    updateChartData(sessions) {
        const wrapper = document.getElementById("chartWrapperContainer");
        let chartEmptyState = document.getElementById("chartEmptyState");
        
        if (!chartEmptyState && wrapper && wrapper.parentElement) {
            chartEmptyState = document.createElement("div");
            chartEmptyState.id = "chartEmptyState";
            chartEmptyState.style.cssText = "padding: 2.5rem 1rem; text-align: center; background: rgba(0, 242, 254, 0.05); border: 1px dashed rgba(0, 242, 254, 0.3); border-radius: 14px; margin-top: 1rem; display: none;";
            chartEmptyState.innerHTML = `
                <div style="font-size: 2.5rem; margin-bottom: 0.8rem;">📈</div>
                <h3 style="color: #00f2fe; font-size: 1.1rem; margin-bottom: 0.4rem; font-weight: 700;">Графік динаміки</h3>
                <p style="color: var(--text-secondary); font-size: 0.9rem; max-width: 400px; margin: 0 auto; line-height: 1.4;">Немає даних для побудови графіка.</p>
            `;
            wrapper.parentElement.insertBefore(chartEmptyState, wrapper);
        }

        if (!sessions || sessions.length === 0) {
            if (wrapper) wrapper.style.display = "none";
            if (chartEmptyState) chartEmptyState.style.display = "block";
            return;
        }

        if (chartEmptyState) chartEmptyState.style.display = "none";
        if (wrapper) wrapper.style.display = "block";

        if (this.doctorChart && typeof Chart !== "undefined") {
            const bubbleData = [];
            const bgColors = [];
            const borderColors = [];

            sessions.forEach(s => {
                const amp = s.amplitude || 0;
                const smooth = s.smoothness || 0;
                const flex = s.flexionsCount || 0;
                
                let color = "rgba(255, 145, 0, 0.7)"; // Оранжевая зона (Прогресс)
                let border = "rgba(255, 145, 0, 1)";
                
                if (amp >= 80 && smooth >= 60) {
                    color = "rgba(0, 230, 118, 0.7)"; // Зеленая зона (Норма)
                    border = "rgba(0, 230, 118, 1)";
                } else if (amp < 50 || smooth < 40) {
                    color = "rgba(255, 23, 68, 0.7)"; // Красная зона (Проблема)
                    border = "rgba(255, 23, 68, 1)";
                }

                const r = Math.min(25, Math.max(5, Math.log(flex + 1) * 4));

                bubbleData.push({
                    x: smooth,
                    y: amp,
                    r: r,
                    flexions: flex
                });
                bgColors.push(color);
                borderColors.push(border);
            });

            this.doctorChart.data.datasets[0].data = bubbleData;
            this.doctorChart.data.datasets[0].backgroundColor = bgColors;
            this.doctorChart.data.datasets[0].borderColor = borderColors;
            this.doctorChart.update();
        }
    }

    downloadCSV(sessions, filename) {
        if (!sessions || sessions.length === 0) {
            alert("Немає даних для експорту.");
            return;
        }

        const headers = ["ПІБ Пацієнта", "Дата", "Мінімальний кут (°)", "Максимальний кут (°)", "Амплітуда (°)", "Середня швидкість (°/с)", "Плавність (%)", "Кількість згинань", "Тривалість сесії (с)"];
        const csvRows = [headers.join(",")];

        for (const s of sessions) {
            const safeName = (s.patientId || 'Пацієнт').replace(/"/g, '""');
            const safeDate = (s.dateStr || '').replace(/"/g, '""');
            const row = [
                `"${safeName}"`,
                `"${safeDate}"`,
                s.minAngle || 0,
                s.maxAngle || 0,
                s.amplitude || 0,
                s.avgSpeed || 0,
                s.smoothness || 0,
                s.flexionsCount || 0,
                s.sessionDuration || 0
            ];
            csvRows.push(row.join(","));
        }

        const blob = new Blob([csvRows.join("\n")], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.setAttribute("download", filename);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}
