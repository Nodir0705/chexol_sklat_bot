import { store } from '../store/index.js';

export default {
    setup() {
        return { store };
    },
    template: `
    <div class="space-y-4">
        <h2 class="text-xl font-bold text-gray-800">📦 Ombor</h2>
        
        <!-- Category Tabs (Mock) -->
        <div class="flex space-x-2 overflow-x-auto no-scrollbar pb-2">
            <button class="px-4 py-2 bg-black text-white rounded-full text-sm font-medium whitespace-nowrap">Hammasi</button>
            <button class="px-4 py-2 bg-white text-gray-600 rounded-full text-sm font-medium whitespace-nowrap">Sabzavot</button>
            <button class="px-4 py-2 bg-white text-gray-600 rounded-full text-sm font-medium whitespace-nowrap">Mevalar</button>
            <button class="px-4 py-2 bg-white text-gray-600 rounded-full text-sm font-medium whitespace-nowrap">Go'sht</button>
        </div>

        <!-- Inventory Grid -->
        <div class="grid grid-cols-2 gap-3">
            <div v-for="item in store.items" :key="item.id" class="bg-white p-3 rounded-2xl shadow-sm relative">
                <!-- Status Dot -->
                <div class="absolute top-3 right-3 w-2 h-2 rounded-full" 
                     :class="item.quantity <= item.threshold ? 'bg-red-500' : 'bg-green-500'"></div>
                
                <div class="flex justify-center mb-2 text-4xl">
                    <!-- Placeholder Icon logic -->
                    🥔
                </div>
                
                <div class="text-center mb-3">
                    <div class="font-bold text-gray-800">{{ item.name }}</div>
                    <div class="text-xs text-gray-500">{{ item.category }}</div>
                </div>

                <!-- Stepper -->
                <div class="flex items-center justify-between bg-gray-50 rounded-xl p-1">
                    <button @click="store.updateQuantity(item.id, -1)" class="w-8 h-8 flex items-center justify-center bg-white rounded-lg shadow-sm text-gray-600 active:scale-90 transition">-</button>
                    <span class="font-bold text-sm">{{ item.quantity }} {{ item.unit }}</span>
                    <button @click="store.updateQuantity(item.id, 1)" class="w-8 h-8 flex items-center justify-center bg-white rounded-lg shadow-sm text-blue-600 active:scale-90 transition">+</button>
                </div>
            </div>
        </div>
    </div>
    `
}
