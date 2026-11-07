const { createApp } = Vue;
createApp({
    data() {
        const defaultBasePrice = 2000;
        return {
            products: [],
            currentView: 'calculator',
            views: [
                { id: 'calculator', label: '商品收益计算', icon: '▣' },
                { id: 'manage', label: '商品管理', icon: '◇' },
                { id: 'friends', label: '好友报价', icon: '♧' }
            ],
            search: '',
            librarySearch: '',
            profitFilter: 'all',
            sortOrder: '',
            selectedProduct: null,
            dialog: null,
            editingProductIndex: null,
            formError: '',
            dialogOpener: null,
            newProduct: { name: '', basePrice: defaultBasePrice, discount: 0 },
            friends: [],
            newFriend: { name: '', discounts: {} },
            quantity: 1,
            basePrice: defaultBasePrice,  // 统一基础价格，方便后续修改和扩展
        }
    },
    mounted() {
        // Load data already stored in browser
        const savedProducts = localStorage.getItem('products');
        if (savedProducts) this.products = JSON.parse(savedProducts);

        const savedFriends = localStorage.getItem('friends');
        if (savedFriends) this.friends = JSON.parse(savedFriends);

        const savedQuantity = localStorage.getItem('quantity');
        if (savedQuantity) this.quantity = parseInt(savedQuantity);
    },
    computed: {
        activeProduct() {
            return this.products.includes(this.selectedProduct) ? this.selectedProduct : this.products[0] || null;
        },
        visibleProducts() {
            const keyword = this.search.trim().toLocaleLowerCase();
            const entries = this.products.map((product, index) => ({ product, index })).filter(({ product }) => {
                const diff = this.getMaxDiff(product, 1).diff;
                return product.name.toLocaleLowerCase().includes(keyword) &&
                    (this.profitFilter === 'all' || (this.profitFilter === 'positive' ? diff > 0 : diff <= 0));
            });
            if (this.sortOrder) entries.sort((a, b) => (this.sortOrder === 'desc' ? -1 : 1) * (this.returnRate(a.product) - this.returnRate(b.product)));
            return entries;
        },
        libraryProducts() {
            const keyword = this.librarySearch.trim().toLocaleLowerCase();
            return this.products.map((product, index) => ({ product, index })).filter(({ product }) => product.name.toLocaleLowerCase().includes(keyword));
        },
        // 计算所有商品中的最大差价
        globalMaxDiff() {
            if (this.products.length === 0 || this.friends.length === 0) {
                return { productName: '', friend: '', diff: 0 };
            }

            let maxDiff = -Infinity;
            let maxDiffProduct = null;
            let maxDiffFriend = '';

            this.products.forEach(product => {
                const maxDiffInfo = this.getMaxDiff(product, this.quantity);
                if (maxDiffInfo.diff > maxDiff) {
                    maxDiff = maxDiffInfo.diff;
                    maxDiffProduct = product;
                    maxDiffFriend = maxDiffInfo.friend;
                }
            });

            return {
                productName: maxDiffProduct ? maxDiffProduct.name : '',
                friend: maxDiffFriend,
                diff: maxDiff === -Infinity ? 0 : maxDiff
            };
        }
    },
    watch: {
        products: {
            handler() {
                this.saveProducts();
            },
            deep: true
        },
        friends: {
            handler() {
                this.saveFriends();
            },
            deep: true
        },
        quantity() {
            this.saveQuantity();
        }
    },
    methods: {
        money(value) {
            return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        },
        bestPrice(product) {
            return this.ownPrice(product) + this.getMaxDiff(product, 1).diff;
        },
        returnRate(product) {
            const own = this.ownPrice(product);
            return own ? this.getMaxDiff(product, 1).diff / own * 100 : 0;
        },
        bestFriendIndex(product) {
            if (!this.friends.length) return -1;
            let best = 0;
            this.friends.forEach((friend, index) => {
                if (this.calcPrice(product, friend.discounts[product.name]) > this.calcPrice(product, this.friends[best].discounts[product.name])) best = index;
            });
            return best;
        },
        
        // 添加商品的弹窗
        openProductDialog(index = null) {
            this.editingProductIndex = index;
            this.newProduct = index === null ? { name: '', basePrice: this.basePrice, discount: 0 } : { ...this.products[index] };
            this.openDialog('product');
        },

        // 添加好友的弹窗
        openFriendDialog() {
            this.newFriend = { name: '', discounts: {} };
            this.openDialog('friend');
        },

        openDialog(kind) {
            this.dialogOpener = document.activeElement;
            this.formError = '';
            this.dialog = kind;
            this.$nextTick(() => this.$refs.dialogName.focus());
        },
        closeDialog() {
            this.dialog = null;
            this.formError = '';
            this.$nextTick(() => {
                if (this.dialogOpener && this.dialogOpener.isConnected) this.dialogOpener.focus();
            });
        },
        trapDialogFocus(event) {
            const controls = [...this.$refs.dialogPanel.querySelectorAll('button, input, select, [tabindex="0"]')].filter(element => !element.disabled);
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        },
        submitProduct() {
            const name = this.newProduct.name.trim();
            if (!name) { this.formError = '请填写商品名称。'; return; }
            if (this.products.some((product, index) => index !== this.editingProductIndex && product.name === name)) {
                this.formError = '已存在同名商品，请使用不同名称，以免好友报价混淆。';
                return;
            }
            this.newProduct.name = name;
            if (this.editingProductIndex === null) {
                this.addProduct();
                this.selectedProduct = this.products[this.products.length - 1];
            } else {
                const product = this.products[this.editingProductIndex];
                const oldName = product.name;
                if (oldName !== name) {
                    [...this.friends, this.newFriend].forEach(friend => {
                        if (Object.prototype.hasOwnProperty.call(friend.discounts, oldName)) {
                            friend.discounts[name] = friend.discounts[oldName];
                            delete friend.discounts[oldName];
                        }
                    });
                }
                Object.assign(product, this.newProduct);
                this.saveProducts();
                this.saveFriends();
            }
            this.closeDialog();
        },
        submitFriend() {
            if (!this.newFriend.name.trim()) { this.formError = '请填写好友名称。'; return; }
            this.newFriend.name = this.newFriend.name.trim();
            this.addFriend();
            this.closeDialog();
        },
        // 计算单个物品的实际价格
        ownPrice(item) {
            return item.basePrice * (1 + item.discount / 100);
        },
        addProduct() {
            if (!this.newProduct.name) return;
            this.products.push({ ...this.newProduct });
            this.newProduct = { name: '', basePrice: this.basePrice, discount: 0 };
            this.saveProducts();
        },
        removeProduct(index) {
            const removedProduct = this.products[index];
            if (!removedProduct) return;

            this.products.splice(index, 1);
            this.friends.forEach(friend => {
                delete friend.discounts[removedProduct.name];
            });
            delete this.newFriend.discounts[removedProduct.name];

            this.saveProducts();
            this.saveFriends();
        },
        saveProducts() {
            const toSave = this.products.map(p => ({ name: p.name, basePrice: p.basePrice, discount: p.discount }));
            localStorage.setItem('products', JSON.stringify(toSave));
        },
        addFriend() {
            if (!this.newFriend.name) return;
            this.friends.push({ name: this.newFriend.name, discounts: { ...this.newFriend.discounts } });
            this.newFriend = { name: '', discounts: {} };
            this.saveFriends();
        },
        removeFriend(index) {
            this.friends.splice(index, 1);
            this.saveFriends();
        },
        saveFriends() {
            localStorage.setItem('friends', JSON.stringify(this.friends));
        },
        calcPrice(item, discount) {
            return item.basePrice * (1 + item.discount / 100) * (1 + (discount || 0) / 100);
        },
        getCellClass(value) {
            if (value > 0) return 'red';
            if (value < 0) return 'green';
            return '';
        },
        getMaxDiff(item, quantity) {
            let maxDiff = -Infinity;
            let maxFriend = '';

            const own = this.ownPrice(item);
            this.friends.forEach(friend => {
                const fPrice = this.calcPrice(item, friend.discounts[item.name]);
                const diff = (fPrice - own) * quantity;
                if (diff > maxDiff) {
                    maxDiff = diff;
                    maxFriend = friend.name;
                }
            });
            return { friend: maxFriend || '-', diff: maxDiff === -Infinity ? 0 : maxDiff };
        },
        resetData(){
            if(confirm('确定要清空所有商品和好友数据吗？此操作不可逆。')){
                this.products = [];
                this.friends = [];
                this.newProduct = { name: '', basePrice: this.basePrice, discount: 0 };
                this.newFriend = { name: '', discounts: {} };
                this.quantity = 1;
                this.selectedProduct = null;
                this.search = '';
                this.librarySearch = '';
                this.profitFilter = 'all';
                this.sortOrder = '';
                this.saveFriends();
                this.saveProducts();
                this.saveQuantity();

            }
        },
        saveQuantity(){
            localStorage.setItem('quantity', this.quantity);
        }
    }
}).mount('#app');
