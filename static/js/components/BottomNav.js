export default {
    template: `
    <nav class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 pb-safe shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
        <div class="flex justify-around items-center h-16">
            <router-link to="/" class="flex flex-col items-center justify-center w-full h-full text-gray-400" active-class="text-blue-500">
                <span class="text-2xl">🏠</span>
                <span class="text-[10px] mt-1 font-medium">Bosh sahifa</span>
            </router-link>
            
            <router-link to="/inventory" class="flex flex-col items-center justify-center w-full h-full text-gray-400" active-class="text-blue-500">
                <span class="text-2xl">📦</span>
                <span class="text-[10px] mt-1 font-medium">Ombor</span>
            </router-link>
            
            <div class="relative -top-5">
                <button @click="$emit('open-add')" class="w-14 h-14 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-lg transform active:scale-95 transition">
                    <span class="text-2xl font-bold">+</span>
                </button>
            </div>

            <router-link to="/shopping" class="flex flex-col items-center justify-center w-full h-full text-gray-400" active-class="text-blue-500">
                <span class="text-2xl">🛒</span>
                <span class="text-[10px] mt-1 font-medium">Bozorlik</span>
            </router-link>
            
            <router-link to="/recipes" class="flex flex-col items-center justify-center w-full h-full text-gray-400" active-class="text-blue-500">
                <span class="text-2xl">🍲</span>
                <span class="text-[10px] mt-1 font-medium">Taomlar</span>
            </router-link>
        </div>
    </nav>
    `
}
