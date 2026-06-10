import { store } from '../store/index.js';

export default {
    setup() {
        return { store };
    },
    template: `
    <div class="space-y-6">
        <!-- Header -->
        <div class="flex justify-between items-center">
            <div>
                <h1 class="text-2xl font-bold text-gray-800">Assalomu alaykum!</h1>
                <p class="text-sm text-gray-500">Bugun oshxonada nima bor?</p>
            </div>
            <div class="w-10 h-10 rounded-full bg-gray-200 overflow-hidden">
                <!-- User Avatar Placehoder -->
                <img src="https://via.placeholder.com/40" class="w-full h-full object-cover">
            </div>
        </div>

        <!-- Stats Cards -->
        <div class="grid grid-cols-2 gap-4">
            <div class="card p-4 rounded-2xl shadow-sm">
                <div class="text-gray-500 text-xs font-medium uppercase mb-1">Jami Mahsulot</div>
                <div class="text-2xl font-bold text-gray-800">{{ store.items.length }}</div>
            </div>
            <div class="card p-4 rounded-2xl shadow-sm border border-red-100 bg-red-50">
                <div class="text-red-500 text-xs font-medium uppercase mb-1">Kam Qolgan</div>
                <div class="text-2xl font-bold text-red-600">{{ store.lowStockItems.length }}</div>
            </div>
        </div>

        <!-- Low Stock Alert -->
        <div v-if="store.lowStockItems.length > 0" class="bg-white rounded-2xl p-4 shadow-sm">
            <h3 class="font-bold text-gray-800 mb-3 flex items-center">
                <span class="mr-2">⚠️</span> Tugayotgan mahsulotlar
            </h3>
            <div class="space-y-3">
                <div v-for="item in store.lowStockItems" :key="item.id" class="flex items-center justify-between p-2 bg-gray-50 rounded-xl">
                    <div class="flex items-center space-x-3">
                        <div class="w-10 h-10 rounded-full bg-white flex items-center justify-center text-xl shadow-sm">
                            🥔
                        </div>
                        <div>
                            <div class="font-bold text-gray-800">{{ item.name }}</div>
                            <div class="text-xs text-red-500 font-medium">{{ item.quantity }} {{ item.unit }} qoldi</div>
                        </div>
                    </div>
                    <button class="bg-blue-100 text-blue-600 p-2 rounded-lg text-sm font-bold">
                        + Qo'shish
                    </button>
                </div>
            </div>
        </div>
    </div>
    `
}
