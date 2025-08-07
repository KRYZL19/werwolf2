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

    socket.on("createRoom", ({ name, room, wolves, maxPlayers }) => {
        try {
            if (rooms[room]) {
                socket.emit("errorMessage", "Raum existiert bereits.");
                return;
            }

            rooms[room] = {
                host: socket.id,
                players: [{ id: socket.id, name, role: null, alive: true }],
                wolves,
                maxPlayers,
                started: false,
                phase: "lobby",
                wolfVotes: {},
                dayVotes: {},
                victims: [],
                readyForNextGame: []
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

            r.players.push({ id: socket.id, name, role: null, alive: true });
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

    socket.on("wolfVote", ({ room, target }) => {
        try {
            const r = rooms[room];
            if (!r || r.phase !== "night") return;

            const player = r.players.find(p => p.id === socket.id);
            if (!player || player.role !== "Werwolf" || !player.alive) return;

            // Vote speichern
            r.wolfVotes[socket.id] = target;

            // Allen Werwölfen die aktuellen Votes übermitteln
            const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
            wolves.forEach(wolf => {
                io.to(wolf.id).emit("updateWolfVotes", r.wolfVotes);
            });

            // Prüfen, ob alle Werwölfe abgestimmt haben und das gleiche Ziel haben
            const allWolvesVoted = wolves.every(wolf => r.wolfVotes[wolf.id]);
            if (allWolvesVoted) {
                const votes = Object.values(r.wolfVotes);
                const allSameTarget = votes.every(v => v === votes[0]);

                if (allSameTarget) {
                    // Opfer festlegen und zur Tagesphase übergehen
                    const victim = r.players.find(p => p.id === votes[0]);
                    if (victim) {
                        victim.alive = false;
                        r.victims.push(victim);

                        // Phase auf "announcement" setzen
                        r.phase = "announcement";

                        // Allen Spielern das Opfer mitteilen
                        io.to(room).emit("announceVictim", {
                            id: victim.id,
                            name: victim.name
                        });

                        // Benachrichtigung an das Opfer senden
                        io.to(victim.id).emit("playerEliminated", victim.id);

                        // Spielstatus prüfen
                        checkGameStatus(room);
                    }
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
                role: p.role,
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
            const r = rooms[room];
            if (!r) return;

            // Spieler als bereit für nächstes Spiel markieren
            if (!r.readyForNextGame.includes(socket.id)) {
                r.readyForNextGame.push(socket.id);
            }

            console.log(`Spieler ${name} ist bereit für die nächste Runde (${r.readyForNextGame.length}/${r.players.filter(p => p.alive).length})`);

            // Update anderen Spielern, wer bereit ist
            io.to(room).emit("updatePlayerList", r.players.filter(p =>
                r.readyForNextGame.includes(p.id) && p.alive
            ).map(p => ({
                id: p.id,
                name: p.name,
                alive: true
            })));

            // Wenn alle lebenden Spieler bereit sind und genug für ein Spiel, neues Spiel starten
            const alivePlayers = r.players.filter(p => p.alive);
            const readyAlivePlayers = alivePlayers.filter(p => r.readyForNextGame.includes(p.id));
            const minPlayers = Math.max(4, r.wolves + 2); // Mindestens 4 Spieler oder Werwölfe + 2

            if (readyAlivePlayers.length === alivePlayers.length && alivePlayers.length >= minPlayers) {
                console.log(`Starte neue Runde mit ${alivePlayers.length} Spielern`);

                // Spielerliste aktualisieren - nur lebende Spieler behalten
                r.players = r.players.filter(p => p.alive);

                // Rollen zurücksetzen
                r.players.forEach(p => {
                    p.role = null;
                    p.alive = true;
                });

                // Spielstatus zurücksetzen
                r.started = true;
                r.phase = "lobby";
                r.wolfVotes = {};
                r.dayVotes = {};
                r.victims = [];
                r.readyForNextGame = [];

                // Alle benachrichtigen, dass ein neues Spiel beginnt
                io.to(room).emit("gameStatus", { status: "Neues Spiel beginnt..." });

                // Spiel starten
                setTimeout(() => startGame(room), 3000);
            }
        } catch (error) {
            console.error("Fehler beim Vorbereiten des nächsten Spiels:", error);
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

        // Rollen zuweisen
        const wolfCount = Math.min(r.wolves, Math.floor(r.players.length / 3));
        for (let i = 0; i < wolfCount; i++) {
            shuffled[i].role = "Werwolf";
            shuffled[i].alive = true;
        }
        for (let i = wolfCount; i < shuffled.length; i++) {
            shuffled[i].role = "Dorfbewohner";
            shuffled[i].alive = true;
        }

        for (const player of shuffled) {
            io.to(player.id).emit("showRole", player.role);
        }

        // Aktualisierte Spielerliste an alle senden
        io.to(room).emit("updatePlayerList", r.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            role: p.role
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
        r.wolfVotes = {};

        // Aktualisierte Spielerliste mit Rollen und Lebensstatus senden
        const updatedPlayerList = r.players.map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            role: p.role
        }));

        io.to(room).emit("updatePlayerList", updatedPlayerList);
        io.to(room).emit("startNight");
    } catch (error) {
        console.error("Fehler beim Starten der Nachtphase:", error);
    }
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

                // Allen Spielern das Opfer mitteilen
                io.to(room).emit("announceVictim", {
                    id: victim.id,
                    name: victim.name,
                    votes: maxVotes
                });

                // Benachrichtigung an das Opfer senden
                io.to(victim.id).emit("playerEliminated", victim.id);

                // Aktualisierte Spielerliste senden
                io.to(room).emit("updatePlayerList", r.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    alive: p.alive,
                    role: p.role
                })));

                // Spielstatus prüfen
                if (checkGameStatus(room)) {
                    return; // Spiel ist vorbei
                }

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
        const villagers = r.players.filter(p => p.role === "Dorfbewohner" && p.alive);

        console.log(`Prüfe Spielstatus: ${wolves.length} Werwölfe vs ${villagers.length} Dorfbewohner`);

        // Prüfen, ob genug Spieler übrig sind
        if (wolves.length + villagers.length < 3) {
            console.log("Zu wenige Spieler übrig, beende Spiel");
            if (wolves.length > 0) {
                endGame(room, "Werwölfe"); // Wenn noch Werwölfe da sind, gewinnen sie
                return true;
            } else {
                endGame(room, "Dorfbewohner"); // Ansonsten gewinnen die Dorfbewohner
                return true;
            }
        }

        // Werwölfe haben gewonnen, wenn sie gleich viele oder mehr sind als Dorfbewohner
        if (wolves.length >= villagers.length) {
            console.log("Werwölfe haben gewonnen! (gleiche/mehr Anzahl als Dorfbewohner)");
            endGame(room, "Werwölfe");
            return true;
        }

        // Dorfbewohner haben gewonnen, wenn alle Werwölfe tot sind
        if (wolves.length === 0) {
            console.log("Dorfbewohner haben gewonnen! (alle Werwölfe tot)");
            endGame(room, "Dorfbewohner");
            return true;
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
                    (p.role === "Dorfbewohner" && winner === "Dorfbewohner")
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

        // Sicherstellen, dass alle Spieler das Ereignis empfangen
        for (const player of r.players) {
            io.to(player.id).emit("gameOver", {
                winner,
                players: sortedPlayers
            });
        }

        // Den Raum für ein neues Spiel vorbereiten aber nicht löschen
        r.wolfVotes = {};
        r.dayVotes = {};
        r.readyForNextGame = [];
        r.phase = "gameOver";

        return true;
    } catch (error) {
        console.error("Fehler beim Beenden des Spiels:", error);
        return false;
    }
}
