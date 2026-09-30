/** Find a card by name, set or number and add it to the collection by hand. */
import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatMoney } from '../collection/organise';
import { PrintingResult, addToCollection, defaultPortfolio, searchPrintings } from '../data/db';
import { Condition, GAMES, GameId, Variant } from '../data/types';
import { VARIANTS } from './CardDetailModal';
import { CardImage } from './CardImage';
import { Chips } from './Chips';
import { theme } from './theme';

const PAGE = 40;
const CONDITIONS: Condition[] = ['NM', 'LP', 'MP', 'HP', 'DMG'];

export function AddCardModal({
  visible,
  onClose,
  onAdded,
  initialGameId,
}: {
  visible: boolean;
  onClose: () => void;
  onAdded: () => void;
  initialGameId: GameId | null;
}) {
  const [query, setQuery] = useState('');
  const [gameId, setGameId] = useState<GameId | null>(initialGameId);
  const [results, setResults] = useState<PrintingResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [picked, setPicked] = useState<PrintingResult | null>(null);
  const [variant, setVariant] = useState<Variant>('normal');
  const [condition, setCondition] = useState<Condition>('NM');
  const [quantity, setQuantity] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  // Guards against a slow search landing after a newer one.
  const searchId = useRef(0);

  useEffect(() => {
    if (visible) setGameId(initialGameId);
  }, [visible, initialGameId]);

  useEffect(() => {
    if (!visible) return;
    const id = ++searchId.current;
    if (query.trim() === '') {
      setResults([]);
      setExhausted(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      searchPrintings({ query, gameId, limit: PAGE })
        .then((found) => {
          if (id !== searchId.current) return;
          setResults(found);
          setExhausted(found.length < PAGE);
        })
        .catch(() => id === searchId.current && setResults([]))
        .finally(() => id === searchId.current && setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, gameId, visible]);

  const loadMore = () => {
    if (searching || exhausted || results.length === 0) return;
    const id = searchId.current;
    setSearching(true);
    searchPrintings({ query, gameId, limit: PAGE, offset: results.length })
      .then((found) => {
        if (id !== searchId.current) return;
        setResults((current) => [...current, ...found]);
        setExhausted(found.length < PAGE);
      })
      .finally(() => setSearching(false));
  };

  const pick = (printing: PrintingResult) => {
    setPicked(printing);
    setVariant(printing.variant);
    setCondition('NM');
    setQuantity(1);
    setNotice(null);
  };

  const add = async () => {
    if (!picked) return;
    const portfolio = await defaultPortfolio();
    await addToCollection({ portfolioId: portfolio.id, printingId: picked.id, variant, condition, quantity });
    onAdded();
    setNotice(`Added ${quantity} × ${picked.name}`);
    setPicked(null);
  };

  const close = () => {
    setPicked(null);
    setNotice(null);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Add a card</Text>
          <Pressable onPress={close} accessibilityRole="button">
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Name, set or number — e.g. charizard base, OP17 070"
          placeholderTextColor={theme.textMuted}
          style={styles.input}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
        />
        <Chips
          options={[{ key: null, label: 'All games' }, ...GAMES.map((game) => ({ key: game.id, label: game.name }))]}
          value={gameId}
          onChange={setGameId}
        />
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {query.trim() === ''
                ? 'Type to search the catalogue.'
                : searching
                  ? 'Searching…'
                  : 'No cards found. Check the spelling, or try a different game.'}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.row} onPress={() => pick(item)}>
              <CardImage uri={item.imageUrl} width={44} label={item.name} />
              <View style={styles.rowMain}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {item.setName} · {item.number}
                  {item.rarity ? ` · ${item.rarity}` : ''}
                </Text>
              </View>
              <Text style={styles.rowPrice}>{formatMoney(item.market, item.currency)}</Text>
            </Pressable>
          )}
        />

        {picked ? (
          <View style={styles.panel}>
            <View style={styles.panelHead}>
              <CardImage uri={picked.imageUrl} width={48} label={picked.name} />
              <View style={styles.rowMain}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {picked.name}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {picked.setName} · {picked.number}
                </Text>
              </View>
              <Pressable onPress={() => setPicked(null)} accessibilityLabel="Cancel">
                <Text style={styles.done}>✕</Text>
              </Pressable>
            </View>
            <Chips options={VARIANTS} value={variant} onChange={(next) => next && setVariant(next)} />
            <Chips
              options={CONDITIONS.map((key) => ({ key, label: key }))}
              value={condition}
              onChange={(next) => next && setCondition(next)}
            />
            <View style={styles.panelFoot}>
              <View style={styles.stepper}>
                <Pressable style={styles.stepButton} onPress={() => setQuantity((q) => Math.max(1, q - 1))}>
                  <Text style={styles.stepText}>−</Text>
                </Pressable>
                <Text style={styles.quantity}>{quantity}</Text>
                <Pressable style={styles.stepButton} onPress={() => setQuantity((q) => q + 1)}>
                  <Text style={styles.stepText}>+</Text>
                </Pressable>
              </View>
              <Pressable style={styles.addButton} onPress={() => void add()} accessibilityRole="button">
                <Text style={styles.addText}>Add to collection</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background, paddingTop: theme.spacing(6), paddingHorizontal: theme.spacing(2) },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: theme.spacing(1.5) },
  title: { color: theme.text, fontSize: 22, fontWeight: '700' },
  done: { color: theme.accent, fontSize: 16, fontWeight: '600' },
  input: {
    backgroundColor: theme.surface,
    color: theme.text,
    borderRadius: theme.radius,
    paddingHorizontal: theme.spacing(2),
    paddingVertical: theme.spacing(1.5),
    fontSize: 15,
    marginBottom: theme.spacing(1),
  },
  notice: { color: theme.high, fontSize: 13, marginVertical: theme.spacing(0.5) },
  list: { paddingVertical: theme.spacing(1), gap: theme.spacing(1), paddingBottom: theme.spacing(30) },
  empty: { color: theme.textMuted, textAlign: 'center', marginTop: theme.spacing(5) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: theme.spacing(1.25),
  },
  rowMain: { flex: 1 },
  rowName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  rowMeta: { color: theme.textMuted, fontSize: 12 },
  rowPrice: { color: theme.text, fontSize: 14, fontWeight: '600' },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: theme.spacing(2),
    gap: theme.spacing(1),
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(1.5) },
  panelFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: theme.spacing(0.5) },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing(2) },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { color: theme.text, fontSize: 22, fontWeight: '600' },
  quantity: { color: theme.text, fontSize: 20, fontWeight: '700', minWidth: 24, textAlign: 'center' },
  addButton: { backgroundColor: theme.accent, borderRadius: theme.radius, paddingHorizontal: theme.spacing(3), paddingVertical: theme.spacing(1.5) },
  addText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
