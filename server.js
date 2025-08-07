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
    // ... (deine vorhandenen Events bleiben gleich)

    socket.on("playAgain", ({ room, name }) => {
        const r = rooms[room];
        if (!r) return;

        const player = r.players.find(p => p.id === socket.id);
        if (!player) {
            socket.emit("playerEliminated", socket.id);
            return;
        }

        // Spieler als bereit markieren
        if (!r.readyForNextGame.includes(socket.id)) {
            r.readyForNextGame.push(socket.id);
        }

        console.log(`Spieler ${name} ist bereit für die nächste Runde (${r.readyForNextGame.length}/${r.players.length})`);

        // Update an alle im Raum
        io.to(room).emit("updatePlayerList", r.players.filter(p =>
            r.readyForNextGame.includes(p.id)
        ).map(p => ({
            id: p.id,
            name: p.name,
            alive: true
        })));

        // Wenn alle Spieler bereit sind und genug vorhanden
        const minPlayers = Math.max(4, r.wolves + 2);
        if (r.readyForNextGame.length >= minPlayers &&
            r.readyForNextGame.length === r.players.length) {

            console.log(`Starte neue Runde mit ${r.readyForNextGame.length} Spielern`);

            // Spieler zurücksetzen
            r.players.forEach(p => {
                p.alive = true;
                p.role = null;
            });

            r.started = true;
            r.phase = "lobby";
            r.wolfVotes = {};
            r.dayVotes = {};
            r.victims = [];
            r.readyForNextGame = [];

            // Neues Spiel starten
            io.to(room).emit("gameStatus", { status: "Neues Spiel beginnt..." });
            setTimeout(() => startGame(room), 3000);
        }
    });
});

// ↓ HIERBLEIBEN alle weiteren Funktionen wie startGame(), startNightPhase(), endDayPhase(), checkGameStatus(), endGame()

function startGame(room) {
    const r = rooms[room];
    if (!r) return;

    const shuffled = [...r.players].sort(() => Math.random() - 0.5);

    const wolfCount = Math.min(r.wolves, Math.floor(r.players.length / 3));
    for (let i = 0; i < wolfCount; i++) {
        shuffled[i].role = "Werwolf";
    }
    for (let i = wolfCount; i < shuffled.length; i++) {
        shuffled[i].role = "Dorfbewohner";
    }

    shuffled.forEach(p => p.alive = true);

    for (const player of shuffled) {
        io.to(player.id).emit("showRole", player.role);
    }

    io.to(room).emit("updatePlayerList", r.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        role: p.role
    })));

    setTimeout(() => startNightPhase(room), 10000);
}

function startNightPhase(room) {
    const r = rooms[room];
    if (!r) return;

    r.phase = "night";
    r.wolfVotes = {};

    const updatedPlayerList = r.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        role: p.role
    }));

    io.to(room).emit("updatePlayerList", updatedPlayerList);
    io.to(room).emit("startNight");
}

function endDayPhase(room) {
    const r = rooms[room];
    if (!r) return;

    const voteCounts = {};
    let skipVotes = 0;
    const alivePlayers = r.players.filter(p => p.alive);
    const totalVoters = alivePlayers.length;

    for (const [voterId, targetId] of Object.entries(r.dayVotes)) {
        const voter = r.players.find(p => p.id === voterId);
        if (!voter || !voter.alive) continue;

        if (targetId === "skip") {
            skipVotes++;
        } else {
            const targetPlayer = r.players.find(p => p.id === targetId);
            if (targetPlayer && targetPlayer.alive) {
                voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
            }
        }
    }

    let maxVotes = 0;
    let mostVoted = null;

    for (const [targetId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
            maxVotes = count;
            mostVoted = targetId;
        }
    }

    const voteThreshold = Math.floor(totalVoters / 2) + 1;

    if (mostVoted && maxVotes >= voteThreshold) {
        const victim = r.players.find(p => p.id === mostVoted);
        if (victim && victim.alive) {
            victim.alive = false;
            r.victims.push(victim);

            io.to(room).emit("announceVictim", {
                id: victim.id,
                name: victim.name
            });

            io.to(victim.id).emit("playerEliminated", victim.id);

            io.to(room).emit("updatePlayerList", r.players.map(p => ({
                id: p.id,
                name: p.name,
                alive: p.alive,
                role: p.role
            })));

            if (checkGameStatus(room)) return;

            setTimeout(() => startNightPhase(room), 5000);
        } else {
            io.to(room).emit("noElimination");
        }
    } else {
        io.to(room).emit("noElimination");
    }
}

function checkGameStatus(room) {
    const r = rooms[room];
    if (!r) return false;

    const wolves = r.players.filter(p => p.role === "Werwolf" && p.alive);
    const villagers = r.players.filter(p => p.role === "Dorfbewohner" && p.alive);

    if (wolves.length + villagers.length < 3) {
        if (wolves.length > 0) {
            endGame(room, "Werwölfe");
        } else {
            endGame(room, "Dorfbewohner");
        }
        return true;
    }

    if (wolves.length >= villagers.length) {
        endGame(room, "Werwölfe");
        return true;
    }

    if (wolves.length === 0) {
        endGame(room, "Dorfbewohner");
        return true;
    }

    return false;
}

function endGame(room, winner) {
    const r = rooms[room];
    if (!r) return;

    if (r.phase === "gameOver") return;
    r.phase = "gameOver";
    r.started = false;
    r.readyForNextGame = [];

    const sortedPlayers = r.players.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        alive: p.alive,
        isWinner: (p.role === "Werwolf" && winner === "Werwölfe") ||
            (p.role === "Dorfbewohner" && winner === "Dorfbewohner")
    })).sort((a, b) => {
        if (a.isWinner && !b.isWinner) return -1;
        if (!a.isWinner && b.isWinner) return 1;
        if (a.role !== b.role) return a.role === "Werwolf" ? -1 : 1;
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        return 0;
    });

    for (const player of r.players) {
        io.to(player.id).emit("gameOver", {
            winner,
            players: sortedPlayers
        });
    }

    r.wolfVotes = {};
    r.dayVotes = {};
    r.readyForNextGame = [];
    r.phase = "gameOver";
}
