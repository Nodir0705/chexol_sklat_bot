ITEMS_UZ = {
    "🥦 Sabzavotlar": ["Kartoshka", "Piyoz", "Sabzi", "Pomidor", "Bodring", "Karam", "Sarimsoq", "Bulg'or qalampiri", "Baqlajon", "Oshqovoq"],
    "🍎 Mevalar": ["Olma", "Uzum", "Nok", "Anor", "Limon", "Banan", "O'rik", "Shaftoli", "Qovun", "Tarvuz"],
    "🥩 Go'sht va Tuxum": ["Mol go'shti", "Qo'y go'shti", "Tovuq", "Tuxum", "Kolbasa", "Sosiska", "Baliq", "Qiyma"],
    "🥛 Sut mahsulotlari": ["Sut", "Qatiq", "Saryog'", "Pishloq", "Qaymoq", "Tvorog", "Smetana", "Kefir"],
    "🍞 Non va Don": ["Non", "Un", "Guruch", "Makaron", "Grechka", "Mosh", "Loviya", "Noxat", "Yorma", "Suli yormasi"],
    "🧂 Ziravor va Bakaleya": ["O'simlik yog'i", "Tuz", "Shakar", "Choy", "Tomat", "Kofe", "Sirka", "Murch", "Zira"],
    "🧹 Xo'jalik": ["Sovun", "Yuvish kukuni", "Idish yuvish suyuqligi", "Tish pastasi", "Shampun", "Hojatxona qog'ozi"]
}

# Mapping items to Emojis for visual generation
ITEM_EMOJIS = {
    "Kartoshka": "🥔", "Piyoz": "🧅", "Sabzi": "🥕", "Pomidor": "🍅", "Bodring": "🥒", "Karam": "🥬", 
    "Sarimsoq": "🧄", "Bulg'or qalampiri": "🫑", "Baqlajon": "🍆", "Oshqovoq": "🎃",
    "Olma": "🍎", "Uzum": "🍇", "Nok": "🍐", "Anor": "🥫", "Limon": "🍋", "Banan": "🍌", 
    "O'rik": "🍑", "Shaftoli": "🍑", "Qovun": "🍈", "Tarvuz": "🍉",
    "Mol go'shti": "🥩", "Qo'y go'shti": "🍖", "Tovuq": "🍗", "Tuxum": "🥚", "Kolbasa": "🌭", 
    "Sosiska": "🌭", "Baliq": "🐟", "Qiyma": "🥩",
    "Sut": "🥛", "Qatiq": "🥛", "Saryog'": "🧈", "Pishloq": "🧀", "Qaymoq": "🥣", 
    "Tvorog": "🍚", "Smetana": "🥣", "Kefir": "🥛",
    "Non": "🍞", "Un": "🌾", "Guruch": "🍚", "Makaron": "🍝", "Grechka": "🥣", 
    "Mosh": "🫘", "Loviya": "🫘", "Noxat": "🥜", "Yorma": "🥣", "Suli yormasi": "🥣",
    "O'simlik yog'i": "🌻", "Tuz": "🧂", "Shakar": "🍬", "Choy": "🍵", "Tomat": "🥫", 
    "Kofe": "☕", "Sirka": "🍶", "Murch": "🌶️", "Zira": "🌿",
    "Sovun": "🧼", "Yuvish kukuni": "🧺", "Idish yuvish suyuqligi": "🧴", 
    "Tish pastasi": "🪥", "Shampun": "🧴", "Hojatxona qog'ozi": "🧻"
}

# Uzbek → Russian item name translations
ITEM_NAMES_RU = {
    "Kartoshka": "Картошка", "Piyoz": "Лук", "Sabzi": "Морковь", "Pomidor": "Помидор",
    "Bodring": "Огурец", "Karam": "Капуста", "Sarimsoq": "Чеснок",
    "Bulg'or qalampiri": "Болгарский перец", "Baqlajon": "Баклажан", "Oshqovoq": "Тыква",
    "Olma": "Яблоко", "Uzum": "Виноград", "Nok": "Груша", "Anor": "Гранат",
    "Limon": "Лимон", "Banan": "Банан", "O'rik": "Абрикос", "Shaftoli": "Персик",
    "Qovun": "Дыня", "Tarvuz": "Арбуз",
    "Mol go'shti": "Говядина", "Qo'y go'shti": "Баранина", "Tovuq": "Курица",
    "Tuxum": "Яйца", "Kolbasa": "Колбаса", "Sosiska": "Сосиски",
    "Baliq": "Рыба", "Qiyma": "Фарш",
    "Sut": "Молоко", "Qatiq": "Катык", "Saryog'": "Масло сливочное",
    "Pishloq": "Сыр", "Qaymoq": "Каймак", "Tvorog": "Творог",
    "Smetana": "Сметана", "Kefir": "Кефир",
    "Non": "Лепёшка", "Un": "Мука", "Guruch": "Рис", "Makaron": "Макароны",
    "Grechka": "Гречка", "Mosh": "Маш", "Loviya": "Фасоль",
    "Noxat": "Нут", "Yorma": "Крупа", "Suli yormasi": "Овсянка",
    "O'simlik yog'i": "Растительное масло", "Tuz": "Соль", "Shakar": "Сахар",
    "Choy": "Чай", "Tomat": "Томатная паста", "Kofe": "Кофе",
    "Sirka": "Уксус", "Murch": "Перец", "Zira": "Зира",
    "Sovun": "Мыло", "Yuvish kukuni": "Стиральный порошок",
    "Idish yuvish suyuqligi": "Средство для посуды", "Tish pastasi": "Зубная паста",
    "Shampun": "Шампунь", "Hojatxona qog'ozi": "Туалетная бумага",
}

# Allowed units per item (first one is the default)
ITEM_UNITS = {
    # Sabzavotlar — kg or dona
    "Kartoshka": ["kg", "dona"], "Piyoz": ["kg", "dona"], "Sabzi": ["kg", "dona"], "Pomidor": ["kg", "dona"],
    "Bodring": ["kg", "dona"], "Karam": ["kg", "dona"], "Sarimsoq": ["dona", "kg"],
    "Bulg'or qalampiri": ["kg", "dona"], "Baqlajon": ["kg", "dona"], "Oshqovoq": ["kg", "dona"],
    # Mevalar — kg or dona
    "Olma": ["kg"], "Uzum": ["kg"], "Nok": ["kg"], "Anor": ["dona", "kg"],
    "Limon": ["dona", "kg"], "Banan": ["dona", "kg"], "O'rik": ["kg"],
    "Shaftoli": ["kg"], "Qovun": ["dona"], "Tarvuz": ["dona"],
    # Go'sht va Tuxum — kg or dona
    "Mol go'shti": ["kg"], "Qo'y go'shti": ["kg"], "Tovuq": ["kg", "dona"],
    "Tuxum": ["dona"], "Kolbasa": ["kg"], "Sosiska": ["kg", "dona"],
    "Baliq": ["kg"], "Qiyma": ["kg"],
    # Sut mahsulotlari — litr, kg, or dona
    "Sut": ["litr"], "Qatiq": ["litr"], "Saryog'": ["kg", "dona"],
    "Pishloq": ["kg"], "Qaymoq": ["kg", "litr"], "Tvorog": ["kg"],
    "Smetana": ["kg", "dona"], "Kefir": ["litr"],
    # Non va Don — kg or dona
    "Non": ["dona"], "Un": ["kg"], "Guruch": ["kg"], "Makaron": ["kg", "dona"],
    "Grechka": ["kg"], "Mosh": ["kg"], "Loviya": ["kg"],
    "Noxat": ["kg"], "Yorma": ["kg"], "Suli yormasi": ["kg"],
    # Ziravor va Bakaleya
    "O'simlik yog'i": ["litr"], "Tuz": ["gram", "kg"], "Shakar": ["kg", "gram"],
    "Choy": ["gram", "kg"], "Tomat": ["gram", "kg"], "Kofe": ["gram", "kg"],
    "Sirka": ["litr"], "Murch": ["gram", "kg"], "Zira": ["gram", "kg"],
    # Xo'jalik — dona or paket
    "Sovun": ["dona"], "Yuvish kukuni": ["kg", "dona"],
    "Idish yuvish suyuqligi": ["dona"], "Tish pastasi": ["dona"],
    "Shampun": ["dona"], "Hojatxona qog'ozi": ["dona", "paket"],
}

# Common quantities for quick selection
QUANTITIES = [
    ("0.5 kg", 0.5, "kg"), ("1 kg", 1, "kg"), ("2 kg", 2, "kg"), ("3 kg", 3, "kg"), ("5 kg", 5, "kg"),
    ("50 gram", 50, "gram"), ("100 gram", 100, "gram"), ("200 gram", 200, "gram"), ("500 gram", 500, "gram"),
    ("1 dona", 1, "dona"), ("5 dona", 5, "dona"), ("10 dona", 10, "dona"), ("30 dona", 30, "dona"),
    ("1 litr", 1, "litr"), ("2 litr", 2, "litr"), ("5 litr", 5, "litr")
]
