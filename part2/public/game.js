var socket = null;
var isDisplay = window.location.pathname === '/display';

var app = new Vue({
    el: '#game',
    data: {
        connected: false,
        isDisplay: isDisplay,
        gameState: {
            phase: 'joining',
            players: [],
            audience: [],
            admin: null,
            currentRound: 1,
            sessionPrompts: [],
            promptSubmitters: [],
            activePrompts: [],
            currentPromptIndex: 0,
            currentVoters: [],
            answeredPlayers: [],
            scores: {}
        },
        username: '',
        password: '',
        hasJoined: false,
        promptText: '',
        promptSubmitted: false,
        answerTexts: {},
        statusMessage: '',
        statusType: 'success',
        joinUrl: window.location.origin + '/'
    },
    computed: {
        isPlayer: function() {
            var self = this;
            return this.gameState.players.some(function(p) { return p.username === self.username; });
        },
        isAudience: function() {
            var self = this;
            return this.gameState.audience.some(function(p) { return p.username === self.username; });
        },
        isAdmin: function() {
            return this.gameState.admin === this.username;
        },
        hasVoted: function() {
            return this.gameState.currentVoters.indexOf(this.username) !== -1;
        },
        myPrompts: function() {
            var self = this;
            return this.gameState.activePrompts
                .map(function(p, i) {
                    return { text: p.text, players: p.players, answers: p.answers, votes: p.votes, index: i };
                })
                .filter(function(p) { return p.players.indexOf(self.username) !== -1; });
        },
        currentPrompt: function() {
            return this.gameState.activePrompts[this.gameState.currentPromptIndex] || null;
        },
        sortedPlayers: function() {
            var self = this;
            return this.gameState.players.slice().sort(function(a, b) {
                return (self.gameState.scores[b.username] || 0) - (self.gameState.scores[a.username] || 0);
            });
        },
        showNextButton: function() {
            return this.isAdmin && this.gameState.phase !== 'game_over';
        }
    },
    watch: {
        'gameState.phase': function(newPhase) {
            if (newPhase === 'prompt') {
                this.promptSubmitted = false;
                this.promptText = '';
            }
            if (newPhase === 'answering') {
                var self = this;
                var texts = {};
                this.gameState.activePrompts.forEach(function(p, idx) {
                    if (p.players.indexOf(self.username) !== -1) {
                        texts[idx] = '';
                    }
                });
                this.answerTexts = texts;
            }
        }
    },
    mounted: function() {
        connect();
    },
    methods: {
        register: function() {
            if (!this.username || !this.password) return;
            socket.emit('register', { username: this.username, password: this.password });
        },
        login: function() {
            if (!this.username || !this.password) return;
            socket.emit('login', { username: this.username, password: this.password });
        },
        submitPrompt: function() {
            var text = this.promptText.trim();
            if (!text) return;
            socket.emit('prompt', { username: this.username, text: text });
        },
        submitAnswer: function(promptIndex) {
            var answer = this.answerTexts[promptIndex];
            if (!answer || !answer.trim()) return;
            socket.emit('answer', { username: this.username, promptIndex: promptIndex, answer: answer.trim() });
        },
        vote: function(choice) {
            if (this.hasVoted) return;
            socket.emit('vote', { username: this.username, choice: choice });
        },
        next: function() {
            socket.emit('next', { username: this.username });
        },
        showStatus: function(msg, type) {
            this.statusMessage = msg;
            this.statusType = type || 'success';
        },
        clearStatus: function() {
            this.statusMessage = '';
        },
        hasAnswer: function(prompt) {
            return !!(prompt.answers[this.username] && prompt.answers[this.username] !== '');
        },
        getAnswer: function(prompt, playerIndex) {
            var player = prompt.players[playerIndex];
            return prompt.answers[player] || '(no answer)';
        },
        getVotes: function(prompt, playerIndex) {
            var player = prompt.players[playerIndex];
            return prompt.votes[player] || 0;
        },
        canVote: function(choice) {
            if (!this.currentPrompt || this.hasVoted) return false;
            var player = this.currentPrompt.players[choice === 'A' ? 0 : 1];
            return player !== this.username;
        },
        isOwnAnswer: function(choice) {
            if (!this.currentPrompt) return false;
            var player = this.currentPrompt.players[choice === 'A' ? 0 : 1];
            return player === this.username;
        }
    }
});

function connect() {
    socket = io();

    socket.on('connect', function() {
        app.connected = true;
    });

    socket.on('connect_error', function(message) {
        alert('Unable to connect: ' + message);
    });

    socket.on('disconnect', function() {
        app.connected = false;
    });

    socket.on('state', function(newState) {
        app.gameState = newState;
    });

    socket.on('register', function(response) {
        if (response.result) {
            app.hasJoined = true;
            app.showStatus('Registered and joined!', 'success');
        } else {
            app.showStatus(response.msg, 'danger');
        }
    });

    socket.on('login', function(response) {
        if (response.result) {
            app.hasJoined = true;
            app.showStatus('Logged in!', 'success');
        } else {
            app.showStatus(response.msg, 'danger');
        }
    });

    socket.on('prompt', function(response) {
        if (response.result) {
            app.promptSubmitted = true;
            app.promptText = '';
            app.showStatus('Prompt submitted!', 'success');
        } else {
            app.showStatus(response.msg, 'danger');
        }
    });

    socket.on('answer', function(response) {
        if (response.result) {
            app.showStatus('Answer submitted!', 'success');
        } else {
            app.showStatus(response.msg, 'danger');
        }
    });

    socket.on('vote', function(response) {
        if (response.result) {
            app.showStatus('Vote recorded!', 'success');
        } else {
            app.showStatus(response.msg, 'danger');
        }
    });
}
