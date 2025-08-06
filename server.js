const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
server.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));

app.use(express.static(__dirname + "/public"));

let rooms = {};

io.on("connection", (socket) => {
    // Verfügbare Räume abrufen
    socket.on("getAvailableRooms", () => {
        const availableRooms = Object.entries(rooms)
            .filter(([_, room]) => !room.started || room.phase === "lobby")
            .map(([id, room]) => ({
                id,
                players: room.players.length,
                maxPlayers: room.maxPlayers,
                wolves: room.wolves
            }));

        socket.emit("availableRooms", availableRooms);
    });

    socket.on("createRoom", ({ name, room, wolves, maxPlayers }) => {
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
    });

    socket.on("joinRoom", ({ name, room }) => {
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
    });

    socket.on("wolfVote", ({ room, target }) => {
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
    });

    socket.on("readyForDay", ({ room }) => {
        const r = rooms[room];
        if (!r || r.phase !== "announcement") return;

        // Phase auf "day" setzen
        r.phase = "day";
        r.dayVotes = {};

        // Tagesphase starten - nur lebende Spieler senden
        io.to(room).emit("startDay", {
            alivePlayers: r.players.filter(p => p.alive).map(p => ({
                id: p.id,
                name: p.name,
                role: p.role // Role hinzufügen, damit Client filtern kann
            }))
        });
    });

    // Chat für tote Spieler
    socket.on("deadChat", ({ room, name, message }) => {
        const r = rooms[room];
        if (!r) return;

        // Prüfen, ob der Spieler tot ist
        const player = r.players.find(p => p.id === socket.id);
        if (!player || player.alive) return; // Nur tote Spieler dürfen chatten

        // Nachricht sanititieren (optional)
        const sanitizedMessage = message.substring(0, 200).trim(); // Längenbegrenzung

        // Nachricht an alle toten Spieler senden
        const deadPlayers = r.players.filter(p => !p.alive);
        const chatMessage = { name, message: sanitizedMessage, timestamp: Date.now() };

        deadPlayers.forEach(deadPlayer => {
            io.to(deadPlayer.id).emit("deadChatMessage", chatMessage);
        });
    });

    socket.on("dayVote", ({ room, target }) => {
        const r = rooms[room];
        if (!r || r.phase !== "day") return;

        const player = r.players.find(p => p.id === socket.id);
        if (!player || !player.alive) return;

        // Vote speichern (auch Skip-Votes)
        r.dayVotes[socket.id] = target;

        // Prüfen, ob alle lebenden Spieler abgestimmt haben
        const alivePlayers = r.players.filter(p => p.alive);
        const allVoted = alivePlayers.every(p => r.dayVotes[p.id]);

        if (allVoted) {
            endDayPhase(room);
        }
    });

    socket.on("readyForNight", ({ room }) => {
        const r = rooms[room];
        if (!r) return;

        // Nachtphase starten
        startNightPhase(room);
    });

    socket.on("disconnect", () => {
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
    });
});

function startGame(room) {
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

    // Rollen an Spieler senden
    for (const player of shuffled) {
        io.to(player.id).emit("showRole", player.role);
    }

    // Aktualisierte Spielerliste an alle senden, jetzt mit Rollen
    io.to(room).emit("updatePlayerList", r.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        role: p.role // Rollen mitschicken, damit Client Werwölfe erkennen kann
    })));

    // Nach 10 Sekunden die erste Nachtphase starten
    setTimeout(() => startNightPhase(room), 10000);
}

function startNightPhase(room) {
    const r = rooms[room];
    if (!r) return;

    r.phase = "night";
    r.wolfVotes = {};

    // Aktualisierte Spielerliste mit Rollen und Lebensstatus senden
    io.to(room).emit("updatePlayerList", r.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        role: p.role
    })));

    io.to(room).emit("startNight");
}

function endDayPhase(room) {
    const r = rooms[room];
    if (!r) return;

    // Votes zählen (Skip-Votes ignorieren)
    const voteCounts = {};
    let skipVotes = 0;
    let totalValidVotes = 0;
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
                totalValidVotes++;
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
                votes: maxVotes,
                totalVotes: totalVoters
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
}

function checkGameStatus(room) {
    const r = rooms[room];
    if (!r) return false;

    const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
    const villagers = r.players.filter(p => p.role === "Dorfbewohner" && p.alive);

    // Werwölfe haben gewonnen, wenn sie gleich viele oder mehr sind als Dorfbewohner
    if (wolves.length >= villagers.length) {
        endGame(room, "Werwölfe");
        return true;
    }

    // Dorfbewohner haben gewonnen, wenn alle Werwölfe tot sind
    if (wolves.length === 0) {
        endGame(room, "Dorfbewohner");
        return true;
    }

    return false;
}

function endGame(room, winner) {
    const r = rooms[room];
    if (!r) return;

    r.phase = "gameOver";
    r.started = false;
    r.readyForNextGame = [];

    io.to(room).emit("gameOver", {
        winner,
        players: r.players.map(p => ({
            id: p.id,
            name: p.name,
            role: p.role,
            alive: p.alive
        }))
    });
}
