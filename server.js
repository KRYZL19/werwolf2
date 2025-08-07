const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));

app.use(express.static(__dirname + "/public"));

let rooms = {};

function displayRole(role) {
    return role === "Werwolf" ? "Werwolf" : "Dorfbewohner";
}

io.on("connection", (socket) => {
    // Verfügbare Räume abrufen
    socket.on("getAvailableRooms", () => {
        try {
            const availableRooms = Object.entries(rooms)
                .filter(([_, room]) => !room.started || room.phase === "lobby")
                .map(([id, room]) => ({
                    id,
                    players: room.players.length,
                    maxPlayers: room.maxPlayers,
                    wolves: room.wolves
                }));

            socket.emit("availableRooms", availableRooms);
        } catch (error) {
            console.error("Fehler beim Abrufen der Räume:", error);
            socket.emit("errorMessage", "Fehler beim Abrufen der Räume");
        }
    });

    socket.on("createRoom", ({ name, room, wolves, maxPlayers, witch = 0, amor = 0, seer = 0 }) => {
        try {
            if (rooms[room]) {
                socket.emit("errorMessage", "Raum existiert bereits.");
                return;
            }

            rooms[room] = {
                host: socket.id,
                players: [{ id: socket.id, name, role: null, alive: true, lover: null }],
                wolves,
                maxPlayers,
                witch,
                amor,
                seer,
                started: false,
                phase: "lobby",
                wolfVotes: {},
                dayVotes: {},
                victims: [],
                readyForNextGame: [],
                lovers: [],
                night: 0,
                witchHealUsed: false,
                witchPoisonUsed: false,
                nightVictim: null,
                poisonVictim: null,
                nightStage: null
            };

            socket.join(room);
            socket.data.room = room;

            // Rauminfo an den Spieler senden
            socket.emit("roomInfo", {
                maxPlayers: rooms[room].maxPlayers,
                players: rooms[room].players
            });

            io.to(room).emit("updatePlayerList", rooms[room].players.map(p => ({
                id: p.id,
                name: p.name,
                alive: p.alive
            })));
        } catch (error) {
            console.error("Fehler beim Erstellen des Raums:", error);
            socket.emit("errorMessage", "Fehler beim Erstellen des Raums");
        }
    });

    socket.on("joinRoom", ({ name, room }) => {
        try {
            const r = rooms[room];
            if (!r) {
                socket.emit("errorMessage", "Raum nicht gefunden.");
                return;
            }

            if (r.started && !r.readyForNextGame.includes(socket.id)) {
                socket.emit("errorMessage", "Spiel bereits gestartet.");
                return;
            }

            if (r.players.length >= r.maxPlayers) {
                socket.emit("errorMessage", "Raum ist voll.");
                return;
            }

            r.players.push({ id: socket.id, name, role: null, alive: true, lover: null });
            socket.join(room);
            socket.data.room = room;

            // Rauminfo an den Spieler senden
            socket.emit("roomInfo", {
                maxPlayers: r.maxPlayers,
                players: r.players
            });

            io.to(room).emit("updatePlayerList", r.players.map(p => ({
                id: p.id,
                name: p.name,
                alive: p.alive
            })));

            if (r.players.length === r.maxPlayers) {
                r.started = true;
                setTimeout(() => startGame(room), 5000);
            }
        } catch (error) {
            console.error("Fehler beim Beitreten zum Raum:", error);
            socket.emit("errorMessage", "Fehler beim Beitreten zum Raum");
        }
    });

    // Chat für tote Spieler
    socket.on("deadChat", ({ room, name, message }) => {
        try {
            const r = rooms[room];
            if (!r) return;

            // Prüfen, ob der Spieler tot ist
            const player = r.players.find(p => p.id === socket.id);
            if (!player || player.alive) return; // Nur tote Spieler dürfen chatten

            // Nachricht sanitieren
            const sanitizedMessage = message.substring(0, 200).trim(); // Längenbegrenzung

            // Nachricht an alle toten Spieler senden
            const deadPlayers = r.players.filter(p => !p.alive);
            const chatMessage = {
                name,
                message: sanitizedMessage,
                timestamp: Date.now(),
                senderId: socket.id // Sender-ID hinzufügen
            };

            deadPlayers.forEach(deadPlayer => {
                io.to(deadPlayer.id).emit("deadChatMessage", chatMessage);
            });
        } catch (error) {
            console.error("Fehler beim Senden der Chat-Nachricht:", error);
        }
    });

    socket.on("amorSelected", ({ room, first, second }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "night" || r.nightStage !== "amor") return;
            const amor = r.players.find(p => p.id === socket.id);
            if (!amor || amor.role !== "Amor" || !amor.alive) return;

            if (first === socket.id || second === socket.id || first === second) return;
            const p1 = r.players.find(p => p.id === first && p.alive);
            const p2 = r.players.find(p => p.id === second && p.alive);
            if (!p1 || !p2) return;

            r.lovers = [p1.id, p2.id];
            p1.lover = p2.id;
            p2.lover = p1.id;

            io.to(p1.id).emit("loverAssigned", { name: p2.name, loverId: p2.id });
            io.to(p2.id).emit("loverAssigned", { name: p1.name, loverId: p1.id });

            r.nightStage = null;
            nextNightStage(room);
        } catch (error) {
            console.error("Fehler bei Amor-Auswahl:", error);
        }
    });

    socket.on("seerSelection", ({ room, target }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "night" || r.nightStage !== "seer") return;
            const seer = r.players.find(p => p.id === socket.id);
            if (!seer || seer.role !== "Seher" || !seer.alive) return;

            const targetPlayer = r.players.find(p => p.id === target);
            if (!targetPlayer || !targetPlayer.alive) return;

            io.to(seer.id).emit("seerResult", {
                name: targetPlayer.name,
                isWolf: targetPlayer.role === "Werwolf"
            });

            startWolfStage(room);
        } catch (error) {
            console.error("Fehler bei der Seher-Aktion:", error);
        }
    });

    socket.on("witchDecision", ({ room, heal, poison }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "night" || r.nightStage !== "witch") return;
            const witch = r.players.find(p => p.id === socket.id);
            if (!witch || witch.role !== "Hexe" || !witch.alive) return;

            if (heal && !r.witchHealUsed && r.nightVictim) {
                r.witchHealUsed = true;
                r.nightVictim = null;
            }

            if (poison && !r.witchPoisonUsed) {
                const targetPlayer = r.players.find(p => p.id === poison && p.alive);
                if (targetPlayer && targetPlayer.id !== witch.id) {
                    r.witchPoisonUsed = true;
                    r.poisonVictim = targetPlayer.id;
                }
            }

            finalizeNight(room);
        } catch (error) {
            console.error("Fehler bei der Hexen-Aktion:", error);
        }
    });

    socket.on("wolfVote", ({ room, target }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "night" || r.nightStage !== "wolves") return;

            const player = r.players.find(p => p.id === socket.id);
            if (!player || player.role !== "Werwolf" || !player.alive) return;

            r.wolfVotes[socket.id] = target;

            const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
            wolves.forEach(wolf => {
                io.to(wolf.id).emit("updateWolfVotes", r.wolfVotes);
            });

            const allWolvesVoted = wolves.every(wolf => r.wolfVotes[wolf.id]);
            if (allWolvesVoted) {
                const votes = Object.values(r.wolfVotes);
                const allSameTarget = votes.every(v => v === votes[0]);

                if (allSameTarget) {
                    r.nightVictim = votes[0];
                    r.wolfVotes = {};
                    startWitchStage(room);
                }
            }
        } catch (error) {
            console.error("Fehler bei der Werwolf-Abstimmung:", error);
        }
    });

    socket.on("readyForDay", ({ room }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "announcement") return;

            // Phase auf "day" setzen
            r.phase = "day";
            r.dayVotes = {};

            // Tagesphase starten - nur lebende Spieler mit Rollen senden
            const alivePlayers = r.players.filter(p => p.alive).map(p => ({
                id: p.id,
                name: p.name,
                role: displayRole(p.role),
                alive: true // Explizit nochmal setzen
            }));

            io.to(room).emit("startDay", {
                alivePlayers: alivePlayers
            });
        } catch (error) {
            console.error("Fehler beim Übergang zur Tagesphase:", error);
        }
    });

    socket.on("readyForNight", ({ room }) => {
        try {
            const r = rooms[room];
            if (!r) return;

            // Nachtphase starten
            startNightPhase(room);
        } catch (error) {
            console.error("Fehler beim Übergang zur Nachtphase:", error);
        }
    });

    socket.on("dayVote", ({ room, target }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "day") return;

            const player = r.players.find(p => p.id === socket.id);
            if (!player || !player.alive) return;

            // Vote speichern
            r.dayVotes[socket.id] = target;

            // Prüfen, ob alle lebenden Spieler abgestimmt haben
            const alivePlayers = r.players.filter(p => p.alive);
            const allVoted = alivePlayers.every(p => r.dayVotes[p.id]);

            if (allVoted) {
                endDayPhase(room);
            }
        } catch (error) {
            console.error("Fehler bei der Tagesabstimmung:", error);
        }
    });

    socket.on("playAgain", ({ room, name }) => {
        try {
            // Ignorieren der Anfrage, da wir keine nächste Runde mehr im selben Raum erlauben
            socket.emit("errorMessage", "Bitte kehre zum Hauptmenü zurück und erstelle einen neuen Raum.");
        } catch (error) {
            console.error("Fehler bei der Anfrage zum erneuten Spielen:", error);
        }
    });

    socket.on("disconnect", () => {
        try {
            const room = socket.data.room;
            if (!room || !rooms[room]) return;

            // Spieler aus Ready-Liste entfernen
            if (rooms[room].readyForNextGame) {
                const readyIndex = rooms[room].readyForNextGame.indexOf(socket.id);
                if (readyIndex !== -1) {
                    rooms[room].readyForNextGame.splice(readyIndex, 1);
                }
            }

            const index = rooms[room].players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                rooms[room].players.splice(index, 1);
                io.to(room).emit("updatePlayerList", rooms[room].players.map(p => ({
                    id: p.id,
                    name: p.name,
                    alive: p.alive
                })));

                // Raum löschen, wenn leer
                if (rooms[room].players.length === 0) {
                    delete rooms[room];
                }
                // Spiel beenden, wenn zu wenige Spieler
                else if (rooms[room].started && rooms[room].phase !== "lobby") {
                    checkGameStatus(room);
                }
            }
        } catch (error) {
            console.error("Fehler bei der Disconnect-Behandlung:", error);
        }
    });
});

function startGame(room) {
    try {
        const r = rooms[room];
        if (!r) return;

        const shuffled = [...r.players].sort(() => Math.random() - 0.5);

        r.lovers = [];
        r.night = 0;
        r.witchHealUsed = false;
        r.witchPoisonUsed = false;

        // Rollen zuweisen
        // Benutze die eingestellte Werwolfanzahl, begrenzt auf maximal die Hälfte der Spieler
        const wolfCount = Math.min(r.wolves, Math.floor(r.players.length / 2));
        console.log(`Starte Spiel mit ${wolfCount} Werwölfen von ${r.wolves} eingestellten.`);

        for (let i = 0; i < shuffled.length; i++) {
            if (i < wolfCount) {
                shuffled[i].role = "Werwolf";
            } else {
                shuffled[i].role = "Dorfbewohner";
            }
            shuffled[i].alive = true;
            shuffled[i].lover = null;
        }

        const villagers = shuffled.filter(p => p.role === "Dorfbewohner");
        let vIndex = 0;
        if (r.amor > 0 && villagers[vIndex]) villagers[vIndex++].role = "Amor";
        if (r.seer > 0 && villagers[vIndex]) villagers[vIndex++].role = "Seher";
        if (r.witch > 0 && villagers[vIndex]) villagers[vIndex++].role = "Hexe";

        for (const player of shuffled) {
            io.to(player.id).emit("showRole", player.role);
        }

        // Aktualisierte Spielerliste an alle senden
        io.to(room).emit("updatePlayerList", r.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            role: displayRole(p.role)
        })));

        // Nach 10 Sekunden die erste Nachtphase starten
        setTimeout(() => startNightPhase(room), 10000);
    } catch (error) {
        console.error("Fehler beim Spielstart:", error);
    }
}

function startNightPhase(room) {
    try {
        const r = rooms[room];
        if (!r) return;

        r.phase = "night";
        r.night += 1;
        r.wolfVotes = {};
        r.nightVictim = null;
        r.poisonVictim = null;
        r.nightStage = null;

        // Aktualisierte Spielerliste mit Rollen und Lebensstatus senden
        const updatedPlayerList = r.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            role: displayRole(p.role)
        }));

        io.to(room).emit("updatePlayerList", updatedPlayerList);
        io.to(room).emit("startNight");

        nextNightStage(room);
    } catch (error) {
        console.error("Fehler beim Starten der Nachtphase:", error);
    }
}

function nextNightStage(room) {
    const r = rooms[room];
    if (!r) return;

    if (r.night === 1 && r.lovers.length === 0) {
        const amor = r.players.find(p => p.role === "Amor" && p.alive);
        if (amor) {
            r.nightStage = "amor";
            const options = r.players.filter(p => p.id !== amor.id && p.alive).map(p => ({ id: p.id, name: p.name }));
            io.to(amor.id).emit("amorChoose", options);
            return;
        }
    }

    const seer = r.players.find(p => p.role === "Seher" && p.alive);
    if (seer) {
        r.nightStage = "seer";
        const options = r.players.filter(p => p.id !== seer.id && p.alive).map(p => ({ id: p.id, name: p.name }));
        io.to(seer.id).emit("seerChoose", options);
        return;
    }

    startWolfStage(room);
}

function startWitchStage(room) {
    const r = rooms[room];
    io.to(room).emit("closeWolfVote");
    const witch = r.players.find(p => p.role === "Hexe" && p.alive);
    if (witch) {
        r.nightStage = "witch";
        const victimPlayer = r.players.find(p => p.id === r.nightVictim);
        const options = r.players.filter(p => p.alive).map(p => ({ id: p.id, name: p.name }));
        io.to(witch.id).emit("witchChoose", {
            victim: victimPlayer ? { id: victimPlayer.id, name: victimPlayer.name } : null,
            healUsed: r.witchHealUsed,
            poisonUsed: r.witchPoisonUsed,
            players: options
        });
    } else {
        finalizeNight(room);
    }
}

function startWolfStage(room) {
    const r = rooms[room];
    const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
    if (wolves.length > 0) {
        r.nightStage = "wolves";
        wolves.forEach(w => io.to(w.id).emit("startWolfVote"));
    } else {
        startWitchStage(room);
    }
}

function finalizeNight(room) {
    const r = rooms[room];
    if (!r) return;
    const deaths = [];

    if (r.nightVictim) {
        const victim = r.players.find(p => p.id === r.nightVictim);
        if (victim && victim.alive) {
            victim.alive = false;
            deaths.push(victim);
        }
    }

    if (r.poisonVictim) {
        const poisoned = r.players.find(p => p.id === r.poisonVictim);
        if (poisoned && poisoned.alive) {
            poisoned.alive = false;
            deaths.push(poisoned);
        }
    }

    // Liebestod prüfen
    const loverDeaths = checkLoverDeaths(room, deaths);
    deaths.push(...loverDeaths);

    deaths.forEach(v => r.victims.push(v));

    if (deaths.length > 0) {
        r.phase = "announcement";
        deaths.forEach(v => {
            io.to(room).emit("announceVictim", { id: v.id, name: v.name });
        });
        const gameContinues = !checkGameStatus(room);
        if (gameContinues) {
            deaths.forEach(v => {
                io.to(v.id).emit("playerEliminated", v.id);
            });
        }
    } else {
        r.phase = "announcement";
        io.to(room).emit("announceVictim", { id: null, name: "Niemand" });
        checkGameStatus(room);
    }
}

function checkLoverDeaths(room, currentDeaths = []) {
    const r = rooms[room];
    if (!r || r.lovers.length !== 2) return [];
    const [id1, id2] = r.lovers;
    const lover1 = r.players.find(p => p.id === id1);
    const lover2 = r.players.find(p => p.id === id2);
    const deaths = [];
    if (lover1 && lover2) {
        if (!lover1.alive && lover2.alive && !currentDeaths.includes(lover2)) {
            lover2.alive = false;
            deaths.push(lover2);
        }
        if (!lover2.alive && lover1.alive && !currentDeaths.includes(lover1)) {
            lover1.alive = false;
            deaths.push(lover1);
        }
    }
    return deaths;
}

function endDayPhase(room) {
    try {
        const r = rooms[room];
        if (!r) return;

        // Votes zählen (Skip-Votes ignorieren)
        const voteCounts = {};
        let skipVotes = 0;
        const alivePlayers = r.players.filter(p => p.alive);
        const totalVoters = alivePlayers.length;

        for (const [voterId, targetId] of Object.entries(r.dayVotes)) {
            // Prüfen, ob der Wähler noch lebt
            const voter = r.players.find(p => p.id === voterId);
            if (!voter || !voter.alive) continue;

            if (targetId === "skip") {
                skipVotes++;
            } else {
                // Sicherstellen, dass nur für lebende Spieler abgestimmt wird
                const targetPlayer = r.players.find(p => p.id === targetId);
                if (targetPlayer && targetPlayer.alive) {
                    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
                }
            }
        }

        // Spieler mit den meisten Stimmen finden
        let maxVotes = 0;
        let mostVoted = null;

        for (const [targetId, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) {
                maxVotes = count;
                mostVoted = targetId;
            }
        }

        // Prüfen, ob mehr als 50% der lebenden Spieler für einen Spieler gestimmt haben
        const voteThreshold = Math.floor(totalVoters / 2) + 1;

        if (mostVoted && maxVotes >= voteThreshold) {
            const victim = r.players.find(p => p.id === mostVoted);
            if (victim && victim.alive) { // Nochmals prüfen, ob das Opfer lebt
                victim.alive = false;
                r.victims.push(victim);

                const loverDeaths = checkLoverDeaths(room, [victim]);
                loverDeaths.forEach(ld => {
                    r.victims.push(ld);
                });

                // Allen Spielern das Opfer mitteilen
                io.to(room).emit("announceVictim", {
                    id: victim.id,
                    name: victim.name,
                    votes: maxVotes
                });
                loverDeaths.forEach(ld => {
                    io.to(room).emit("announceVictim", { id: ld.id, name: ld.name });
                });

                // Spielstatus prüfen – RIP nur senden, wenn das Spiel weitergeht
                if (checkGameStatus(room)) {
                    return; // Spiel ist vorbei
                }

                // Benachrichtigungen an Opfer
                io.to(victim.id).emit("playerEliminated", victim.id);
                loverDeaths.forEach(ld => {
                    io.to(ld.id).emit("playerEliminated", ld.id);
                });

                // Aktualisierte Spielerliste senden
                io.to(room).emit("updatePlayerList", r.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    alive: p.alive,
                    role: displayRole(p.role)
                })));

                // Nach 5 Sekunden die nächste Nachtphase starten
                setTimeout(() => startNightPhase(room), 5000);
            } else {
                // Wenn Opfer nicht mehr lebt (unwahrscheinlicher Edge-Case)
                io.to(room).emit("noElimination");
            }
        } else {
            // Wenn keine Mehrheit: "Niemand ist gestorben"
            io.to(room).emit("noElimination");
        }
    } catch (error) {
        console.error("Fehler beim Beenden der Tagesphase:", error);
    }
}

function checkGameStatus(room) {
    try {
        const r = rooms[room];
        if (!r) return false;

        const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
        const villagers = r.players.filter(p => p.role !== "Werwolf" && p.alive);

        console.log(`Prüfe Spielstatus: ${wolves.length} Werwölfe vs ${villagers.length} Dorfbewohner`);

        // Debug-Ausgaben für Siegbedingungen
        console.log(`Siegbedingung Werwölfe: ${wolves.length} >= ${villagers.length} = ${wolves.length >= villagers.length}`);
        console.log(`Siegbedingung Dorfbewohner: ${wolves.length === 0}`);

        // Werwölfe haben gewonnen, wenn sie gleich viele oder mehr sind als Dorfbewohner
        if (wolves.length >= villagers.length) {
            console.log("Werwölfe haben gewonnen! (gleiche/mehr Anzahl als Dorfbewohner)");
            return endGame(room, "Werwölfe");
        }

        // Dorfbewohner haben gewonnen, wenn alle Werwölfe tot sind
        if (wolves.length === 0) {
            console.log("Dorfbewohner haben gewonnen! (alle Werwölfe tot)");
            return endGame(room, "Dorfbewohner");
        }

        // Prüfen, ob genug Spieler übrig sind
        if (wolves.length + villagers.length < 3) {
            console.log("Zu wenige Spieler übrig, beende Spiel");
            if (wolves.length > 0) {
                return endGame(room, "Werwölfe"); // Wenn noch Werwölfe da sind, gewinnen sie
            } else {
                return endGame(room, "Dorfbewohner"); // Ansonsten gewinnen die Dorfbewohner
            }
        }

        return false;
    } catch (error) {
        console.error("Fehler bei der Spielstatusüberprüfung:", error);
        return false;
    }
}

function endGame(room, winner) {
    try {
        const r = rooms[room];
        if (!r) return false;

        // Sicherstellen, dass der Raum nicht schon im gameOver-Zustand ist
        if (r.phase === "gameOver") {
            console.log(`Spiel in Raum ${room} ist bereits beendet.`);
            return false;
        }

        r.phase = "gameOver";
        r.started = false;
        r.readyForNextGame = [];

        console.log(`Spiel in Raum ${room} beendet. Gewinner: ${winner}`);

        // Spieler sortieren: Gewinner zuerst, dann nach Rolle und Status
        const sortedPlayers = r.players.map(p => ({
            id: p.id,
            name: p.name,
            role: p.role,
            alive: p.alive,
            isWinner: (p.role === "Werwolf" && winner === "Werwölfe") ||
                (p.role !== "Werwolf" && winner === "Dorfbewohner")
        })).sort((a, b) => {
            // Gewinner zuerst
            if (a.isWinner && !b.isWinner) return -1;
            if (!a.isWinner && b.isWinner) return 1;
            // Dann nach Rolle (Werwölfe gruppieren)
            if (a.role !== b.role) return a.role === "Werwolf" ? -1 : 1;
            // Dann nach Status (Lebende zuerst)
            if (a.alive !== b.alive) return a.alive ? -1 : 1;
            return 0;
        });

        // Direkt an jeden Spieler individuell senden, um sicherzustellen, dass alle die Nachricht erhalten
        for (const player of r.players) {
            io.to(player.id).emit("gameOver", {
                winner,
                players: sortedPlayers
            });
        }

        // Zusätzlich auch an den ganzen Raum senden
        io.to(room).emit("gameOver", {
            winner,
            players: sortedPlayers
        });

        // Alle Spieler aus dem Raum entfernen
        const roomSockets = io.sockets.adapter.rooms.get(room);
        if (roomSockets) {
            for (const socketId of roomSockets) {
                const clientSocket = io.sockets.sockets.get(socketId);
                if (clientSocket) {
                    clientSocket.leave(room);
                    clientSocket.data.room = null;
                }
            }
        }

        // Räume aufräumen und den Raum nach kurzer Verzögerung löschen
        r.wolfVotes = {};
        r.dayVotes = {};
        r.readyForNextGame = [];

        // Nach 10 Sekunden den Raum komplett löschen
        setTimeout(() => {
            console.log(`Raum ${room} wird gelöscht.`);
            delete rooms[room];
        }, 10000);

        return true;
    } catch (error) {
        console.error("Fehler beim Beenden des Spiels:", error);
        return false;
    }
}
