import HomePage from './pages/HomePage.js';
import InventoryPage from './pages/InventoryPage.js';
import BottomNav from './components/BottomNav.js';

const { createApp } = Vue;
const { createRouter, createWebHashHistory } = VueRouter;

// Routes
const routes = [
    { path: '/', component: HomePage },
    { path: '/inventory', component: InventoryPage },
    { path: '/shopping', component: { template: '<div class="text-center mt-10">🛒 Shopping List (Coming Soon)</div>' } },
    { path: '/recipes', component: { template: '<div class="text-center mt-10">🍲 Recipes (Coming Soon)</div>' } },
];

const router = createRouter({
    history: createWebHashHistory(),
    routes,
});

const app = createApp({
    components: {
        'bottom-nav': BottomNav
    },
    setup() {
        // Initialize Telegram WebApp
        const tg = window.Telegram?.WebApp;
        if (tg) {
            tg.ready();
            tg.expand();
        }
        
        return {};
    }
});

app.use(router);
app.mount('#app');
